import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';

import { InternalServiceAuthGuard } from '../../common/auth/internal-service-auth.guard';
import { ANY_PRODUCT, AllowProducts } from '../../common/auth/allow-products.decorator';
import { CurrentInternalProduct } from '../../common/auth/internal-product.decorator';
import { InternalProduct } from '../../common/auth/internal-product.types';
import { ProductScopeGuard } from '../../common/auth/product-scope.guard';
import { Public } from '../../common/auth/public.decorator';
import { InternalCreateOrderDto } from './dto/internal-order.dto';
import { InternalOrderDetailView } from './dto/internal-order-detail.vo';
import { InternalCreateOrderView } from './dto/internal-order.vo';
import { InternalOrderService } from './internal-order.service';

/**
 * 内网 · 服务端下单（产品 → 门户）。
 *
 * 让产品用自己的服务凭据替用户下单并支付：扣该用户的钱包、触发开通。
 * 设计理由、信任边界和四条护栏见 `InternalOrderService` 的注释与 `docs/30`。
 *
 * ⚠️ 这是**钱**的能力：默认全部产品禁止（`SERVER_ORDER_PRODUCTS` 为空即全禁），
 * 必须逐产品显式开启，并且只能买本产品自己的商品。
 */
@ApiTags('内网 · 服务端下单 internal')
@ApiSecurity('service-bearer')
@Public()
@UseGuards(InternalServiceAuthGuard, ProductScopeGuard)
@AllowProducts(ANY_PRODUCT)
@Controller('internal/orders')
export class InternalOrderController {
  constructor(private readonly service: InternalOrderService) {}

  @Post()
  @ApiOperation({
    summary: '服务端下单并支付（服务凭据）',
    description: [
      '用产品服务凭据替指定用户下单，**一步完成下单 + 扣款 + 入队开通**。',
      '',
      '四条硬性护栏：',
      '1. 产品必须在 `SERVER_ORDER_PRODUCTS` 白名单里（默认全禁）',
      '2. 每一项的 `product_code` 必须等于凭据的 `iss`（只能买自己的商品）',
      '3. 单笔上限 `SERVER_ORDER_MAX_CENTS` + 日累计上限 `SERVER_ORDER_DAILY_MAX_CENTS`',
      '4. `client_order_key` 唯一索引：重复提交返回首次结果，`duplicated=true`',
      '',
      '返回后 `processing_items > 0` 表示开通在进行中（通常 3 秒内），',
      '需用 `GET /api/internal/orders/{order_id}` 轮询（该接口见 docs/30，当前仅支持下单）。',
    ].join('\n'),
  })
  @ApiOkResponse({ type: InternalCreateOrderView, description: '下单结果（含幂等标记）' })
  async create(
    @CurrentInternalProduct() product: InternalProduct,
    @Body() dto: InternalCreateOrderDto,
  ): Promise<InternalCreateOrderView> {
    return this.service.purchase(product, dto);
  }

  @Get(':orderId')
  @ApiOperation({
    summary: '查询订单开通结果（服务凭据）',
    description: [
      '下单后轮询用。**只返回本产品自己的订单项** —— 一个订单可能含多个产品的商品，',
      '产品 A 看不到产品 B 的商品与实例 id。',
      '',
      '- `provision_done=true` 表示开通已全部结束（成功/失败/已退款），**不必再轮询**',
      '- 订单里没有本产品的项，一律返回 `4001`（不暴露"这个用户买没买别家"）',
      '- 只读接口，**不校验** `SERVER_ORDER_PRODUCTS` 白名单（白名单管的是花钱，不是查询）',
      '- 建议轮询间隔 3 秒、最多 60 秒；超时后按 `fail_reason` 处理',
    ].join('\n'),
  })
  @ApiOkResponse({ type: InternalOrderDetailView, description: '订单开通结果（仅本产品的项）' })
  async detail(
    @CurrentInternalProduct() product: InternalProduct,
    @Param('orderId') orderId: string,
  ): Promise<InternalOrderDetailView> {
    return this.service.detail(product, orderId);
  }
}
