import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** 查询参数统一按契约 §0.4：`?page=1&size=20` */
export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20;

  /** 兼容 `page_size` / `limit` 两种常见写法（映射到 size） */
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  page_size?: number;

  get skip(): number {
    return (this.page - 1) * this.effectiveSize;
  }

  get effectiveSize(): number {
    return this.page_size ?? this.size;
  }
}

/** 契约 §3.2 流水查询过滤：type 与 product_code 均可选 */
export class TransactionQueryDto extends PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2, 3, 4], { message: 'type 只能是 1充值 2扣费 3退款 4调账' })
  type?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  product_code?: string;
}

/** 契约 §3.3 充值申请入参 */
export class RechargeApplyDto {
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(10_000_000)
  amount_cents!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}

/** 契约 §6.2 核销入参：`reject: true` 表示驳回 */
export class ConfirmRechargeDto {
  @IsOptional()
  @IsBoolean()
  reject?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

/** 契约 §6 充值核销队列查询：`?status=0`（0 待核销 / 1 已到账 / 2 驳回），缺省不过滤 */
export class RechargeQueryDto extends PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1, 2], { message: 'status 只能是 0待核销 1已到账 2驳回' })
  status?: number;
}
