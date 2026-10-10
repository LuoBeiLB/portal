import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';

import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { BizException, ErrorCode } from '../../common/error-code';
import { Public } from '../../common/public.decorator';
import { RateLimiterService } from '../../common/rate-limiter.service';
import { clientIpOf } from '../../common/request.util';
import { PortalConfigService } from '../../config/portal-config.service';
import { ProductSyncService } from '../product/product-sync.service';
import { CreateOrderDto, OrderListQueryDto, ProductQueryDto } from './dto/order.dto';
import { OrderService } from './order.service';

/**
 * 契约 §2 商城接口。
 *
 * 鉴权分两类：
 * - **公开**：`GET /shop/products` 商品列表 —— 只读目录，无用户维度，游客可看价目表。
 *   代价是失去了 token 这道天然门槛，所以必须自行限流（见该方法的注释）。
 * - **Bearer**：其余接口都含"当前用户"语义（下单、我的订单、支付），去掉 token 无法工作。
 *
 * ⚠️ `@ApiBearerAuth` 刻意**不加在类上**，而是逐个方法标注：控制器级装饰器会应用到所有
 * 方法（含公开的商品列表），OpenAPI 里就会把公开接口也标成要鉴权，前端照文档做会白带 token。
 */
@ApiTags('商城 shop')
@Controller('shop')
export class ShopController {
  constructor(
    private readonly productSync: ProductSyncService,
    private readonly orders: OrderService,
    private readonly limiter: RateLimiterService,
    private readonly config: PortalConfigService,
  ) {}

  /**
   * §2.1 商品列表（**公开接口**）
   *
   * 为什么公开：游客应当能先看价目表再决定注册；这个接口只读商品目录、不含任何用户数据。
   *
   * 为什么必须限流：公开后就没有 token 这道门槛了，而它每次请求都要查库。
   * 这里按**客户端 IP** 做固定窗口计数（默认 120 次/分钟，`PUBLIC_RATE_MAX` 可调），
   * 超限返回 1001 + `data.retry_after`。配合 `ProductSyncService` 的 10 秒列表缓存，
   * 正常用户完全无感知，脚本化拉取会被挡住。
   */
  @ApiOperation({
    summary: '商品列表（契约 §2.1）· 公开，无需登录',
    description:
      '返回 `{ list: [...] }`，不分页。只返回**在售**商品。**无需 token**。\n\n' +
      '`spec` 是**产品自定义结构**，门户原样透传，前端要按 key 通用渲染，别假设一定有某个字段。\n\n' +
      '`stock` 为 `null` 表示不限或产品未上报，**前端显示「现货」而不是「0 件」**。\n\n' +
      '`billing_mode`：1 包周期（下单即扣）、2 按量（购买时 0 元，后付费由产品出账）。\n\n' +
      '⚠️ 这里显示的是缓存价，**下单以后端重算为准**。\n\n' +
      '⚠️ 按 IP 限流；超限返回 `1001` 且 `data.retry_after` 给出需等待秒数。',
  })
  @Public()
  @Get('products')
  async products(@Query() query: ProductQueryDto, @Req() request: Request): Promise<Record<string, unknown>> {
    const { publicRateWindowSeconds: windowSeconds, publicRateMax: max } = this.config.shop;
    if (max > 0) {
      const result = await this.limiter.hit(`shop-products:${clientIpOf(request)}`, windowSeconds, max);
      if (!result.allowed) {
        throw new BizException(ErrorCode.PARAM_INVALID, '请求过于频繁，请稍后再试', {
          retry_after: result.retryAfterSeconds,
        });
      }
    }
    return this.productSync.listForShop(query.product_code);
  }

  /** §2.2 创建订单 */
  @ApiOperation({
    summary: '创建订单（契约 §2.2）',
    description:
      '1~10 项；`quantity` 默认 1、单项最多 10、**云手机（phone）最多 3**。\n\n' +
      '**请求里不要传价格** —— 后端按当前 `p_product` 缓存价重算，传了也不认。\n\n' +
      '错误：4003 商品不存在或已下架（让用户刷新列表）、4004 库存不足。\n\n' +
      '创建时会校验库存，**支付时会再校验一次**。',
  })
  @ApiBearerAuth('bearer')
  @HttpCode(200)
  @ApiOkResponse({ description: '契约 §0.2：业务响应统一 HTTP 200，结果看 body 的 code' })
  @Post('orders')
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrderDto): Promise<Record<string, unknown>> {
    return { ...(await this.orders.create(user.id, dto)) };
  }

  /** 我的订单列表（契约外补充，前端"我的订单"页需要） */
  @ApiOperation({
    summary: '我的订单列表（契约外补充）',
    description:
      '按创建时间倒序分页，返回结构与订单详情一致（含 items）。契约原文只有"订单详情"，此接口是为前端补齐的。',
  })
  @ApiBearerAuth('bearer')
  @Get('orders')
  async listMine(@CurrentUser() user: AuthUser, @Query() query: OrderListQueryDto): Promise<Record<string, unknown>> {
    const page = await this.orders.listMine(user.id, query.page, query.size);
    return { list: page.list, total: page.total, page: page.page, size: page.size };
  }

  /** §2.3 订单详情 */
  @ApiOperation({
    summary: '订单详情（契约 §2.3）',
    description:
      '订单 status：`0` 待支付 · `1` 部分成功 · `2` 全部成功 · `3` 全部失败。\n\n' +
      '订单项 status：`0` 待支付 · `1` 已支付（**开通中**）· `2` 开通成功 · `3` 失败待退款 · `4` 已退款。\n\n' +
      '成功项带 `instance_id` / `expire_at`；失败项带 `fail_reason`（如 `OUT_OF_STOCK`）。',
  })
  @ApiBearerAuth('bearer')
  @Get('orders/:id')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<Record<string, unknown>> {
    return { ...(await this.orders.detail(user.id, id)) };
  }

  /** §2.4 支付 */
  @ApiOperation({
    summary: '支付订单（契约 §2.4）',
    description:
      '**扣费同步完成、开通异步进行**（契约写的是同步循环，本实现把 provision 拆到后台，避免 30s 长请求打满连接池）。\n\n' +
      '返回里：`accepted_items` = 本次受理项数；`processing_items` > 0 表示**还在开通中，前端应轮询订单详情**。\n\n' +
      '已受理的项状态是 `1 已支付`，开通完成后会变成 `2 开通成功` 或 `4 已退款`（失败自动退款）。\n\n' +
      '错误：3001 余额不足（**未处理的项保持 0，充值后可再次点支付**）、4001 订单不存在、4002 订单状态不允许（已全部失败的订单不可再支付）。',
  })
  @ApiBearerAuth('bearer')
  @HttpCode(200)
  @ApiOkResponse({ description: '契约 §0.2：业务响应统一 HTTP 200，结果看 body 的 code' })
  @Post('orders/:id/pay')
  async pay(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<Record<string, unknown>> {
    return { ...(await this.orders.pay(user.id, id)) };
  }
}
