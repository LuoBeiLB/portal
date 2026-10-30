import { ApiProperty } from '@nestjs/swagger';

/** 产品查用户余额的响应 data。 */
export class InternalWalletBalanceView {
  @ApiProperty({
    description: '门户用户 id（原样回显，便于产品对账）',
    example: '01a1b2c3-d4e5-6f70-8192-a3b4c5d6e7f8',
  })
  portal_user_id!: string;

  @ApiProperty({
    description: '余额（**分**）。整数；不返回小数，避免浮点误差',
    example: 12345,
  })
  balance_cents!: number;

  @ApiProperty({
    description: '钱包状态：`0` 正常 · `1` 冻结（冻结时不能扣费，`deduct` 会返回 `3002`）',
    example: 0,
  })
  status!: number;

  @ApiProperty({
    description:
      '是否已开通过钱包。`false` 表示该用户从未产生过资金往来，`balance_cents` 恒为 0。\n\n' +
      '**本接口不会为查询创建钱包**——只读，不产生副作用',
    example: true,
  })
  wallet_exists!: boolean;
}
