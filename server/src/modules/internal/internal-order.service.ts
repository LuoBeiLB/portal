import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { InternalProduct } from '../../common/auth/internal-product.types';
import { BizException, ErrorCode } from '../../common/error/error-code';
import { PortalConfigService } from '../../config/portal-config.service';
import { OrderItemEntity } from '../order/entities/order-item.entity';
import { OrderEntity } from '../order/entities/order.entity';
import { OrderService } from '../order/order.service';
import { UserEntity } from '../user/entities/user.entity';
import { InternalCreateOrderDto } from './dto/internal-order.dto';
import { InternalCreateOrderView } from './dto/internal-order.vo';
import { InternalOrderDetailView, InternalOrderItemView } from './dto/internal-order-detail.vo';

/** 订单视图里我们需要的字段（避免把整个 OrderView 形状耦合进来） */
type OrderLike = Record<string, unknown>;

/**
 * 服务端下单（产品 → 门户）：**下单 + 支付一步完成**。
 *
 * ## 信任边界（重要）
 *
 * 门户**无法**验证"用户是否真的点了购买"——服务凭据只代表产品。
 * 之所以可以接受，是因为 `POST /api/wallet/deduct` 早就能用服务凭据扣任意用户的钱，
 * 本接口没有新增"产品能花用户钱"这个能力，新增的只是"能买商品、能触发开通"。
 *
 * 所以四条护栏是硬性的，不是可选项：
 *
 * | 护栏 | 防什么 |
 * |---|---|
 * | 产品白名单（默认空 = 全禁） | 未评估的产品误用 |
 * | `product_code` 必须等于凭据 `iss` | 产品 A 买产品 B 的商品 |
 * | 单笔 + 日累计上限 | 映射表写错 id 时的最坏损失 |
 * | `client_order_key` 唯一索引 | 重试造成重复订单、重复扣款 |
 *
 * ## 为什么下单和支付合成一个接口
 *
 * 分开两步，产品要维护"已下单未支付"的中间态，超时后要么补偿要么泄漏。
 * 合成一步后，事务内扣款、入队开通，产品只需要看 `processing_items` 轮询开通结果。
 */
@Injectable()
export class InternalOrderService {
  private readonly logger = new Logger(InternalOrderService.name);

  constructor(
    @InjectRepository(OrderEntity) private readonly orders: Repository<OrderEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(OrderItemEntity) private readonly orderItems: Repository<OrderItemEntity>,
    private readonly orderService: OrderService,
    private readonly config: PortalConfigService,
  ) {}

  async purchase(product: InternalProduct, dto: InternalCreateOrderDto): Promise<InternalCreateOrderView> {
    const shop = this.config.shop;

    /* ① 白名单：默认空 = 全部禁止，逐产品显式开 */
    if (!shop.serverOrderProducts.includes(product.code)) {
      throw new BizException(
        ErrorCode.FORBIDDEN,
        `产品 ${product.code} 未开通服务端下单（需在门户配置 SERVER_ORDER_PRODUCTS）`,
      );
    }

    /* ② 只能买自己的商品：否则产品 A 能替用户买产品 B 的套餐 */
    for (const item of dto.items) {
      if (item.product_code !== product.code) {
        throw new BizException(
          ErrorCode.FORBIDDEN,
          `只能购买本产品（${product.code}）的商品，请求里出现了 ${item.product_code}`,
        );
      }
    }

    /* ③ 用户必须存在，且不能是平台管理员（管理员没有钱包语义） */
    const user = await this.users.findOne({ where: { id: dto.portal_user_id } });
    if (!user) {
      throw new BizException(ErrorCode.PARAM_INVALID, 'portal_user_id 不存在');
    }
    if (user.role === 'admin') {
      throw new BizException(ErrorCode.FORBIDDEN, '平台管理员不能作为下单用户');
    }

    /* ④ 幂等：同一个 client_order_key 直接返回首次结果 */
    const existing = await this.orders.findOne({ where: { clientOrderKey: dto.client_order_key } });
    if (existing) {
      if (existing.userId !== dto.portal_user_id) {
        throw new BizException(
          ErrorCode.FORBIDDEN,
          'client_order_key 已被其他用户使用（幂等键必须按用户唯一）',
        );
      }
      const view = (await this.orderService.viewOf(existing.id)) as unknown as OrderLike;
      this.logger.log(
        `服务端下单幂等命中 product=${product.code} user=${user.id} key=${dto.client_order_key} order=${existing.id}`,
      );
      return this.toView(view, true);
    }

    /* ⑤ 日累计上限：与单笔上限一起作用，防"重试风暴把钱包刷空" */
    const cap = await this.resolveCap(user.id);
    if (cap === 0) {
      throw new BizException(ErrorCode.FORBIDDEN, '今日服务端下单额度已用尽');
    }

    /* ⑥ 下单（总价由门户按 p_product 重算，上限在 create 内部校验） */
    let created: unknown;
    try {
      created = await this.orderService.create(
        user.id,
        { items: dto.items },
        { clientOrderKey: dto.client_order_key, maxTotalCents: cap },
      );
    } catch (error) {
      /* 并发下两个请求同时过了 ④，唯一索引会让其中一个失败 —— 转成幂等返回 */
      if (this.isDuplicateKey(error)) {
        const raced = await this.orders.findOne({ where: { clientOrderKey: dto.client_order_key } });
        if (raced) {
          const view = (await this.orderService.viewOf(raced.id)) as unknown as OrderLike;
          return this.toView(view, true);
        }
      }
      throw error;
    }

    const createdLike = created as unknown as OrderLike;
    const orderId = String(createdLike.order_id ?? createdLike.id ?? '');
    if (!orderId) throw new BizException(ErrorCode.PARAM_INVALID, '下单异常：未返回订单 id');

    /* ⑦ 支付（事务内扣钱包 + 入队开通任务） */
    const paid = (await this.orderService.pay(user.id, orderId)) as unknown as OrderLike;

    this.logger.log(
      `服务端下单成功 product=${product.code} actor=service:${product.code} user=${user.id} ` +
        `order=${orderId} key=${dto.client_order_key} consent=${dto.consent_ref ?? '-'} ` +
        `total=${String(paid.total_cents ?? createdLike.total_cents ?? '?')}`,
    );

    return this.toView(paid, false);
  }

  /**
   * 本次允许的金额上限（分）。`0` 表示今日额度已耗尽。
   *
   * 取「单笔上限」与「今日剩余额度」的较小者；配置为 0 表示不限制。
   */
  private async resolveCap(userId: string): Promise<number> {
    const shop = this.config.shop;
    const perOrder = shop.serverOrderMaxCents > 0 ? shop.serverOrderMaxCents : Number.POSITIVE_INFINITY;

    let daily = Number.POSITIVE_INFINITY;
    if (shop.serverOrderDailyMaxCents > 0) {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const raw = await this.orders
        .createQueryBuilder('o')
        .select('COALESCE(SUM(o.total_cents), 0)', 'total')
        .where('o.userId = :userId', { userId })
        .andWhere('o.clientOrderKey IS NOT NULL')
        .andWhere('o.createdAt >= :since', { since })
        .getRawOne<{ total: string | number }>();
      const used = Number(raw?.total ?? 0);
      daily = Math.max(0, shop.serverOrderDailyMaxCents - used);
    }

    const cap = Math.min(perOrder, daily);
    /* create() 里 0 表示不限制，所以"额度耗尽"要单独表达 */
    if (cap === 0) return 0;
    return Number.isFinite(cap) ? cap : 0;
  }

  /**
   * 查询订单开通结果（产品轮询用）。
   *
   * ## 两条过滤，缺一不可
   *
   * 1. **只返回本产品的项**：一个订单可能同时含多个产品的商品（用户在商城一次结算），
   *    产品 A 不能看到产品 B 的商品和实例 id
   * 2. **一项都不属于本产品 → 当订单不存在**（4001，不是 1004）：
   *    否则产品能拿订单 id 探测"这个用户买没买别家的东西"
   *
   * ## 为什么读不校验白名单
   *
   * 白名单管的是"能不能替用户花钱"。读接口只读、且已按产品过滤，
   * 关掉白名单后产品仍应能查历史订单结果（否则对账会断）。
   */
  async detail(product: InternalProduct, orderId: string): Promise<InternalOrderDetailView> {
    if (!/^\d+$/.test(orderId)) {
      throw new BizException(ErrorCode.ORDER_NOT_FOUND);
    }

    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) throw new BizException(ErrorCode.ORDER_NOT_FOUND);

    const items = await this.orderItems.find({
      where: { orderId, productCode: product.code },
      order: { id: 'ASC' },
    });
    if (items.length === 0) throw new BizException(ErrorCode.ORDER_NOT_FOUND);

    const view: InternalOrderItemView[] = items.map((item) => ({
      item_id: String(item.id),
      sku_id: item.skuId,
      quantity: item.quantity,
      price_cents: Number(item.priceCents),
      status: item.status,
      instance_id: item.instanceId ?? null,
      expire_at: item.expireAt ? toIsoSecond(item.expireAt) : null,
      fail_reason: item.failReason ?? null,
    }));

    return {
      order_id: String(order.id),
      order_no: order.orderNo,
      status: order.status,
      total_cents: Number(order.totalCents),
      portal_user_id: order.userId,
      client_order_key: order.clientOrderKey ?? null,
      created_at: toIsoSecond(order.createdAt),
      paid_at: order.paidAt ? toIsoSecond(order.paidAt) : null,
      /* 0 待支付 / 1 已支付待开通 还要等；2 已开通 / 3 待退款 / 4 已退款 都是终态 */
      provision_done: view.every((item) => item.status >= 2),
      returned: view.length,
      items: view,
    };
  }

  private toView(order: OrderLike, duplicated: boolean): InternalCreateOrderView {
    const num = (value: unknown): number => Number(value ?? 0);
    return {
      order_id: String(order.order_id ?? order.id ?? ''),
      order_no: String(order.order_no ?? order.orderNo ?? ''),
      status: num(order.status),
      total_cents: num(order.total_cents ?? order.totalCents),
      accepted_items: num(order.accepted_items),
      processing_items: num(order.processing_items),
      duplicated,
    };
  }

  /** MySQL 唯一索引冲突 */
  private isDuplicateKey(error: unknown): boolean {
    const code = (error as { code?: string; driverError?: { code?: string } })?.code
      ?? (error as { driverError?: { code?: string } })?.driverError?.code;
    return code === 'ER_DUP_ENTRY';
  }
}

/** 去掉毫秒：契约里时间是 UTC ISO 8601 秒精度 */
function toIsoSecond(value: Date): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
