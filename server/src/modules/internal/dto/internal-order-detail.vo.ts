import { ApiProperty } from '@nestjs/swagger';

/** 服务端下单后的开通结果（单条订单项）。 */
export class InternalOrderItemView {
  @ApiProperty({ description: '订单项 id', example: '512' })
  item_id!: string;

  @ApiProperty({ description: 'SKU id', example: 'phone-1c2g' })
  sku_id!: string;

  @ApiProperty({ description: '数量', example: 1 })
  quantity!: number;

  @ApiProperty({ description: '单价快照（分）', example: 80 })
  price_cents!: number;

  @ApiProperty({
    description:
      '开通状态：`0` 待支付 · `1` 已支付待开通 · `2` **已开通** · `3` 开通失败待退款 · `4` 已退款',
    example: 2,
  })
  status!: number;

  @ApiProperty({
    description: '产品侧返回的实例 id；未开通时为 null',
    type: String,
    nullable: true,
    example: 'i-phone-8f21',
  })
  instance_id!: string | null;

  @ApiProperty({
    description: '服务到期时间（UTC ISO 8601）；未开通时为 null',
    type: String,
    nullable: true,
    example: '2026-11-28T00:00:00Z',
  })
  expire_at!: string | null;

  @ApiProperty({
    description: '失败原因（`status=3/4` 时有值）',
    type: String,
    nullable: true,
    example: '产品开通超时',
  })
  fail_reason!: string | null;
}

/** `GET /api/internal/orders/{order_id}` 的响应 data。 */
export class InternalOrderDetailView {
  @ApiProperty({ description: '门户订单 id', example: '281' })
  order_id!: string;

  @ApiProperty({ description: '门户订单号', example: 'O20261028-000123' })
  order_no!: string;

  @ApiProperty({
    description: '订单状态：`0` 待支付 · `1` 部分成功 · `2` **全部成功** · `3` 全部失败',
    example: 2,
  })
  status!: number;

  @ApiProperty({ description: '订单总额（分）', example: 80 })
  total_cents!: number;

  @ApiProperty({ description: '下单用户的门户 id', example: '01a1...' })
  portal_user_id!: string;

  @ApiProperty({ description: '产品侧单号；用户自助下单为 null', type: String, nullable: true })
  client_order_key!: string | null;

  @ApiProperty({ description: '创建时间（UTC ISO 8601）', example: '2026-10-28T07:31:09Z' })
  created_at!: string;

  @ApiProperty({ description: '支付时间；未支付为 null', type: String, nullable: true })
  paid_at!: string | null;

  @ApiProperty({
    description:
      '开通是否**全部完成**（所有项都不再是 `0/1`）。`true` 时不必再轮询',
    example: true,
  })
  provision_done!: boolean;

  @ApiProperty({ description: '本次返回的项数（**只含本产品的项**）', example: 1 })
  returned!: number;

  @ApiProperty({
    description: '开通结果（只含调用方产品自己的项，不会泄露订单里其他产品的商品）',
    type: [InternalOrderItemView],
  })
  items!: InternalOrderItemView[];
}
