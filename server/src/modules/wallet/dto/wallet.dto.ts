import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

import { isIsoDateString } from '../../../common/date.util';

/**
 * 校验 `YYYY-MM-DD` 且必须是真实存在的日历日期。
 * 只查格式的正则会放行 `2026-13-45`，而它在 SQL 字符串比较里静默返回空结果
 * （前端看到"没数据"而不是"参数错误"）—— 实测踩过。
 */
@ValidatorConstraint({ name: 'isoDate', async: false })
class IsoDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return value === undefined || value === null || value === '' || isIsoDateString(value);
  }

  defaultMessage(): string {
    return '$property 需为合法的 YYYY-MM-DD 日期';
  }
}

/** 查询参数统一按契约 §0.4：`?page=1&size=20` */
export class PageQueryDto {
  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1, minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ description: '每页条数（上限 100）', example: 20, minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20;

  @ApiPropertyOptional({ description: '每页条数的别名（兼容 page_size / limit 写法）', example: 20 })
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
  @ApiPropertyOptional({ description: '流水类型', enum: [1, 2, 3, 4], example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2, 3, 4], { message: 'type 只能是 1充值 2扣费 3退款 4调账' })
  type?: number;

  @ApiPropertyOptional({ description: '产品代码过滤', enum: ['storage', 'phone', 'desktop'], example: 'storage' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  product_code?: string;
}

/** 契约 §3.3 充值申请入参 */
export class RechargeApplyDto {
  @ApiProperty({
    description: '充值金额，单位：分（100 ~ 10,000,000，即 ¥1 ~ ¥10万）',
    example: 10000,
    minimum: 100,
    maximum: 10_000_000,
  })
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(10_000_000)
  amount_cents!: number;

  @ApiPropertyOptional({ description: '转账备注 / 凭证说明（供管理员核销时核对）', example: '微信转账，尾号1234' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  remark?: string;
}

/** 契约 §6.2 核销入参：`reject: true` 表示驳回 */
export class ConfirmRechargeDto {
  @ApiPropertyOptional({ description: 'true = 驳回；缺省或 false = 确认到账', example: false, default: false })
  @IsOptional()
  @IsBoolean()
  reject?: boolean;

  @ApiPropertyOptional({ description: '驳回原因（驳回时建议填写）', example: '未收到对应转账' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

/** 契约 §6 充值核销队列查询：`?status=0`（0 待核销 / 1 已到账 / 2 驳回），缺省不过滤 */
export class RechargeQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '充值单状态过滤', enum: [0, 1, 2], example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1, 2], { message: 'status 只能是 0待核销 1已到账 2驳回' })
  status?: number;
}

/**
 * 用户端「我的充值记录」查询（2026-10-10 新增）。
 *
 * 与管理端 `RechargeQueryDto` 参数完全一致，区别只在鉴权与返回字段：
 * 用户端按 JWT 的 sub 过滤、不返回 username/phone。
 */
export class MyRechargeQueryDto extends RechargeQueryDto {}

/**
 * 契约 §6 流水导出查询。
 *
 * 相比列表接口额外支持**日期区间**（管理端最常用的是"导出某天的流水"）
 * 与**行数上限**（导出是数据外泄面，不做无限导出）。
 */
export class ExportTransactionQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '流水类型', enum: [1, 2, 3, 4], example: 2 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([1, 2, 3, 4], { message: 'type 只能是 1充值 2扣费 3退款 4调账' })
  type?: number;

  @ApiPropertyOptional({ description: '产品代码过滤', enum: ['storage', 'phone', 'desktop'], example: 'storage' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  product_code?: string;

  @ApiPropertyOptional({ description: '起始日 YYYY-MM-DD（UTC，含当日）', example: '2026-10-01' })
  @IsOptional()
  @Validate(IsoDateConstraint)
  start_date?: string;

  @ApiPropertyOptional({ description: '结束日 YYYY-MM-DD（UTC，含当日）', example: '2026-10-10' })
  @IsOptional()
  @Validate(IsoDateConstraint)
  end_date?: string;

  @ApiPropertyOptional({
    description: '最大导出行数（上限 50000，缺省 5000）',
    example: 5000,
    minimum: 1,
    maximum: 50000,
  })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === null || value === '' ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(50_000)
  limit?: number;
}
