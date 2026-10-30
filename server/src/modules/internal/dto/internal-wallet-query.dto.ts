import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * 产品查用户余额（`GET /api/internal/wallet/balance`）。
 *
 * 用途：产品在扣费前先看一眼余额，好提前提示充值 —— 否则只能靠 `deduct` 返回 `3001`
 * 才知道余额不足，用户体验是"点了才发现不够"。
 */
export class InternalBalanceQueryDto {
  @ApiProperty({
    description: '**门户**用户 id（UUID），不是产品自己的用户 id',
    example: '01a1b2c3-d4e5-6f70-8192-a3b4c5d6e7f8',
  })
  @IsString()
  @MaxLength(36)
  @Matches(/^[0-9a-fA-F-]{32,36}$/, { message: 'portal_user_id 必须是门户返回的用户 id（UUID）' })
  portal_user_id!: string;
}
