import { ApiProperty } from '@nestjs/swagger';

/** 服务端下单的响应 data。 */
export class InternalCreateOrderView {
  @ApiProperty({ description: '门户订单 id（下钻/查询用）', example: '281' })
  order_id!: string;

  @ApiProperty({ description: '门户订单号（给用户看的）', example: 'O20261028-000123' })
  order_no!: string;

  @ApiProperty({
    description:
      '订单状态：`0` 待支付 · `1` 部分成功（**已扣款、正在开通**）· `2` 全部成功 · `3` 全部失败',
    example: 1,
  })
  status!: number;

  @ApiProperty({ description: '订单总额（分），由门户按当前商品价重算', example: 80 })
  total_cents!: number;

  @ApiProperty({ description: '本次受理的项数（已扣款）', example: 1 })
  accepted_items!: number;

  @ApiProperty({
    description: '仍在开通队列里的项数。**>0 表示还要轮询订单详情**，通常 3 秒内完成',
    example: 1,
  })
  processing_items!: number;

  @ApiProperty({
    description:
      '是否为幂等重复：`true` 表示这个 `client_order_key` 之前已经成功下过单，' +
      '本次没有新建订单、也没有再扣款，返回的是首次结果',
    example: false,
  })
  duplicated!: boolean;
}
