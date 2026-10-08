import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsObject, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/** 契约 §4.1 扣费入参（产品 → 门户，X-Internal-Key） */
export class DeductDto {
  @ApiProperty({ description: '门户用户 UUID（即 JWT 的 sub）', example: '018f3a2b-7c1d-7xxx-9e21-3f9a2b8c1d00' })
  @IsString()
  @MinLength(1)
  @MaxLength(36)
  portal_user_id!: string;

  @ApiProperty({ description: '本产品代码', enum: ['storage', 'phone', 'desktop'], example: 'storage' })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  product_code!: string;

  @ApiProperty({ description: '本产品账单号，≤64 位、产品内全局唯一；**先落库再调用**', example: 'storage-20261005-000123' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  bill_no!: string;

  @ApiProperty({ description: '扣费金额，单位：分，必须 > 0', example: 3000, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount_cents!: number;

  @ApiPropertyOptional({
    description: '账单明细，原样写入流水供用户查看',
    example: { plan: '续费·标准版', period: '30天', instance_id: 'st-0001' },
  })
  @IsOptional()
  @IsObject()
  detail?: Record<string, unknown>;
}

/** 契约 §4.2 退款入参（产品 → 门户，X-Internal-Key） */
export class RefundDto {
  @ApiProperty({ description: '原扣费账单号（必须已入账）', example: 'storage-20261005-000123' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  bill_no!: string;

  @ApiProperty({ description: '本次退款单号，幂等键；**先落库再调用**', example: 'refund:50001:1759200000' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  refund_bill_no!: string;

  @ApiProperty({ description: '退款金额，单位：分；累计退款不得超过原单金额', example: 1000, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount_cents!: number;

  @ApiPropertyOptional({ description: '退款原因，展示给用户', example: '开通失败自动退款' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}
