import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';

import { BizException, ErrorCode } from '../../common/error-code';
import { PortalConfigService } from '../../config/portal-config.service';
import { ProductEntity } from '../product/entities/product.entity';
import { ProductSyncService } from '../product/product-sync.service';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import { CreateOrderDto, OrderItemInputDto } from './dto/order.dto';
import { OrderItemEntity, OrderItemStatus } from './entities/order-item.entity';
import { OrderEntity, OrderStatus } from './entities/order.entity';
import { ProvisionJobEntity, ProvisionJobStatus } from './entities/provision-job.entity';

export interface OrderView {
  order_id: string;
  order_no: string;
  total_cents: number;
  status: number;
  created_at: string;
  paid_at: string | null;
  items: OrderItemView[];
}

export interface OrderItemView {
  item_id: string;
  product_code: string;
  sku_id: string;
  name: string | null;
  quantity: number;
  price_cents: number;
  status: number;
  instance_id: string | null;
  expire_at: string | null;
  fail_reason: string | null;
}

export interface PayResult extends OrderView {
  /** 本次受理了多少项（已扣费、正在开通） */
  accepted_items: number;
  /** 仍在开通中的项数，前端据此决定是否继续轮询 */
  processing_items: number;
}

/**
 * 订单与支付（契约 §2）。
 *
 * 支付采用「**扣费同步 + 开通异步**」：
 * - 扣费必须在 HTTP 请求内完成（用户要知道钱够不够）；
 * - 开通要调产品、超时 30s，放进 `o_provision_job` 由后台 worker 推进，前端轮询订单详情。
 *
 * 这样契约的响应结构不变（仍按项返回状态），但服务端不会被 30s 的长请求拖垮。
 */
@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(OrderEntity) private readonly orders: Repository<OrderEntity>,
    @InjectRepository(OrderItemEntity) private readonly items: Repository<OrderItemEntity>,
    @InjectRepository(ProductEntity) private readonly products: Repository<ProductEntity>,
    @InjectRepository(ProvisionJobEntity) private readonly jobs: Repository<ProvisionJobEntity>,
    private readonly dataSource: DataSource,
    private readonly productSync: ProductSyncService,
    private readonly ledger: WalletLedgerService,
    private readonly config: PortalConfigService,
  ) {}

  /** 契约 §2.2 创建订单：价格一律后端按当前 p_product 重算，**不信任前端传入价格** */
  async create(userId: string, dto: CreateOrderDto): Promise<OrderView> {
    const inputs = dto.items;
    if (inputs.length === 0) throw new BizException(ErrorCode.PARAM_INVALID, 'items 不能为空');
    if (inputs.length > this.config.shop.maxItemsPerOrder) {
      throw new BizException(ErrorCode.PARAM_INVALID, `单次最多 ${this.config.shop.maxItemsPerOrder} 项`);
    }

    // 逐项校验并在内存里算总价（规格与价格以当前缓存为准）
    const resolved: Array<{ input: OrderItemInputDto; product: ProductEntity; quantity: number }> = [];
    for (const input of inputs) {
      const quantity = input.quantity ?? 1;
      const maxQuantity =
        input.product_code === 'phone' ? this.config.shop.phoneMaxQuantity : this.config.shop.maxQuantityPerItem;
      if (quantity < 1 || quantity > maxQuantity) {
        throw new BizException(ErrorCode.PARAM_INVALID, `${input.sku_id} 数量需在 1~${maxQuantity} 之间`);
      }

      const product = await this.productSync.requireActive(input.product_code, input.sku_id);
      if (product.stock !== null && product.stock < quantity) {
        throw new BizException(ErrorCode.STOCK_NOT_ENOUGH, undefined, {
          sku_id: product.skuId,
          stock: product.stock,
        });
      }
      resolved.push({ input, product, quantity });
    }

    // 按量计费（billing_mode=2）购买时 0 元，后付费由产品出账（契约 §2.1）
    const totalCents = resolved.reduce(
      (sum, item) => sum + (item.product.billingMode === 2 ? 0 : item.product.priceCents * item.quantity),
      0,
    );

    const orderNo = generateOrderNo();

    return this.dataSource.transaction(async (manager) => {
      const order = await manager.save(
        manager.create(OrderEntity, {
          orderNo,
          userId,
          totalCents: String(totalCents),
          status: OrderStatus.PENDING,
        }),
      );

      const savedItems: OrderItemEntity[] = [];
      for (const { product, quantity } of resolved) {
        const unitPrice = product.billingMode === 2 ? 0 : product.priceCents;
        const item = await manager.save(
          manager.create(OrderItemEntity, {
            orderId: order.id,
            userId,
            productCode: product.productCode,
            skuId: product.skuId,
            quantity,
            priceCents: String(unitPrice * quantity),
            status: OrderItemStatus.PENDING,
          }),
        );
        savedItems.push(item);
      }

      return (await this.buildView(manager, order.id)) as OrderView;
    });
  }

  /** 契约 §2.3 订单详情 */
  async detail(userId: string, orderId: string): Promise<OrderView> {
    const order = await this.orders.findOne({ where: { id: orderId } });
    if (!order) throw new BizException(ErrorCode.ORDER_NOT_FOUND);
    if (order.userId !== userId) throw new BizException(ErrorCode.ORDER_NOT_FOUND); // 不暴露他人订单存在性
    return (await this.buildView(this.orders.manager, orderId)) as OrderView;
  }

  /** 我的订单列表（契约外补充；前端做"我的订单"页要用） */
  async listMine(userId: string, page: number, size: number): Promise<{ list: OrderView[]; total: number; page: number; size: number }> {
    const [rows, total] = await this.orders.findAndCount({
      where: { userId },
      order: { id: 'DESC' },
      skip: (page - 1) * size,
      take: size,
    });
    const list: OrderView[] = [];
    for (const row of rows) {
      list.push((await this.buildView(this.orders.manager, row.id)) as OrderView);
    }
    return { list, total, page, size };
  }

  /**
   * 契约 §2.4 支付：**逐项扣费（同步）+ 开通（异步排队）**。
   *
   * 与契约的差异（已记录在文档里）：契约把扣费与 provision 写成一个同步循环，
   * 本实现把 provision 拆到后台 worker，因此响应里已扣费项的状态是 **1 已支付**，
   * 开通结果由前端轮询订单详情获取（order_status 会随 worker 推进而变化）。
   *
   * 严格按契约的三条纪律：
   * 1. 幂等键 `bill_no = order:{order_id}:item:{item_id}` —— **逐项扣费**，与契约示例一致；
   * 2. 某一项因余额不足失败 → **停止处理后续项**；
   * 3. 已扣费成功的项保留（可充值后再次 pay 续处理），未处理项保持 0。
   */
  async pay(userId: string, orderId: string): Promise<PayResult> {
    const accepted = await this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(OrderEntity, {
        where: { id: orderId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!order) throw new BizException(ErrorCode.ORDER_NOT_FOUND);
      if (order.userId !== userId) throw new BizException(ErrorCode.ORDER_NOT_FOUND);

      const allItems = await manager.find(OrderItemEntity, { where: { orderId }, order: { id: 'ASC' } });
      const pendingItems = allItems.filter((item) => item.status === OrderItemStatus.PENDING);

      // 没有待支付项：全部成功/全部退款/待退款都属于「不能再支付」→ 4002（契约 §2.4）
      if (pendingItems.length === 0) {
        throw new BizException(ErrorCode.ORDER_STATUS_NOT_ALLOWED, '订单已处理完成，无法再次支付');
      }

      const succeededItemIds: string[] = [];
      const stopReason = new Map<string, string>();

      for (const item of pendingItems) {
        const amount = Number(item.priceCents);
        if (amount > 0) {
          try {
            // 契约 §2.4 的幂等键格式：order:{order_id}:item:{item_id}
            await this.ledger.deductWithin(manager, {
              userId,
              billNo: `order:${order.id}:item:${item.id}`,
              amountCents: amount,
              // 逐项扣费带上 product_code，对账时才能按产品归集（契约 §6 产品账单 vs 门户流水）
              productCode: item.productCode,
              detail: { order_no: order.orderNo, order_item_id: item.id, sku_id: item.skuId },
            });
          } catch (error) {
            // 余额不足/钱包冻结：停止处理后续项（其余项保持 0，可充值后再次支付）
            if (error instanceof BizException) {
              stopReason.set(item.id, error.code === ErrorCode.WALLET_FROZEN ? 'WALLET_FROZEN' : 'INSUFFICIENT_BALANCE');
              break;
            }
            throw error;
          }
        }
        succeededItemIds.push(item.id);
      }

      // 一项都没成功：按契约直接把 3001 抛给前端（未处理项保持 0）
      if (succeededItemIds.length === 0) {
        const first = pendingItems[0];
        const reason = stopReason.get(first.id);
        if (reason === 'WALLET_FROZEN') throw new BizException(ErrorCode.WALLET_FROZEN);
        throw new BizException(ErrorCode.INSUFFICIENT_BALANCE);
      }

      await manager.update(
        OrderItemEntity,
        { id: In(succeededItemIds) },
        { status: OrderItemStatus.PAID },
      );

      // 入队开通任务：order_item_id 唯一索引保证不会重复入队
      const now = new Date();
      for (const itemId of succeededItemIds) {
        const item = pendingItems.find((row) => row.id === itemId)!;
        await manager
          .createQueryBuilder()
          .insert()
          .into(ProvisionJobEntity)
          .values({
            orderId: order.id,
            orderItemId: item.id,
            userId,
            productCode: item.productCode,
            status: ProvisionJobStatus.PENDING,
            attempts: 0,
            maxAttempts: this.config.shop.provisionMaxAttempts,
            nextRunAt: now,
          })
          .orIgnore() // 唯一索引冲突时忽略（幂等重入）
          .execute();
      }

      await manager.update(
        OrderEntity,
        { id: order.id },
        { status: OrderStatus.PARTIAL_SUCCESS, paidAt: new Date(), payingAt: new Date() },
      );

      return { accepted: succeededItemIds.length, orderId: order.id };
    });

    const view = (await this.buildView(this.orders.manager, accepted.orderId)) as OrderView;
    const processing = view.items.filter(
      (item) => item.status === OrderItemStatus.PAID || item.status === OrderItemStatus.FAILED_PENDING_REFUND,
    ).length;

    return { ...view, accepted_items: accepted.accepted, processing_items: processing };
  }

  /** worker 用：按 ID 取订单视图（内部调用，不做归属校验） */
  async viewOf(orderId: string): Promise<OrderView> {
    return (await this.buildView(this.orders.manager, orderId)) as OrderView;
  }

  /** 按状态把订单置为 全部成功 / 部分成功 / 全部失败（worker 每处理完一项调用） */
  async refreshOrderStatus(manager: EntityManager, orderId: string): Promise<OrderStatus> {
    const items = await manager.find(OrderItemEntity, { where: { orderId } });
    const total = items.length;
    const provisioned = items.filter((item) => item.status === OrderItemStatus.PROVISIONED).length;
    const refunded = items.filter((item) => item.status === OrderItemStatus.REFUNDED).length;
    const failed = items.filter((item) => item.status === OrderItemStatus.FAILED_PENDING_REFUND).length;

    let status: OrderStatus;
    if (provisioned === total) status = OrderStatus.ALL_SUCCESS;
    else if (refunded + failed === total) status = OrderStatus.ALL_FAILED;
    else status = OrderStatus.PARTIAL_SUCCESS;

    await manager.update(OrderEntity, { id: orderId }, { status });
    return status;
  }

  /** 组装订单视图（含商品名，来自 p_product 缓存） */
  private async buildView(manager: EntityManager, orderId: string): Promise<OrderView | null> {
    const order = await manager.findOne(OrderEntity, { where: { id: orderId } });
    if (!order) return null;

    const items = await manager.find(OrderItemEntity, { where: { orderId }, order: { id: 'ASC' } });
    const skuIds = [...new Set(items.map((item) => item.skuId))];
    const products = skuIds.length
      ? await manager.find(ProductEntity, { where: { skuId: In(skuIds) } })
      : [];
    const nameOf = new Map(products.map((product) => [`${product.productCode}:${product.skuId}`, product.name]));

    return {
      order_id: order.id,
      order_no: order.orderNo,
      total_cents: Number(order.totalCents),
      status: order.status,
      created_at: iso(order.createdAt),
      paid_at: order.paidAt ? iso(order.paidAt) : null,
      items: items.map((item) => ({
        item_id: item.id,
        product_code: item.productCode,
        sku_id: item.skuId,
        name: nameOf.get(`${item.productCode}:${item.skuId}`) ?? null,
        quantity: item.quantity,
        price_cents: Number(item.priceCents),
        status: item.status,
        instance_id: item.instanceId,
        expire_at: item.expireAt ? iso(item.expireAt) : null,
        fail_reason: item.failReason,
      })),
    };
  }
}

/** 订单号：`O` + UTC 日期 + 6 位随机（唯一索引兜底，冲突概率极低且可重试） */
export function generateOrderNo(date = new Date()): string {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0');
  return `O${ymd}-${random}`;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
