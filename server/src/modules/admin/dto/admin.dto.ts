import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, Validate } from 'class-validator';
import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

import { isIsoDateString } from '../../../common/util/date.util';
import { PageQueryDto } from '../../wallet/dto/wallet.dto';

/** 校验 `YYYY-MM-DD` 且必须是真实存在的日历日期（拒绝 2026-13-45 / 2026-02-30） */
@ValidatorConstraint({ name: 'isoDate', async: false })
class IsoDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return value === undefined || value === null || value === '' || isIsoDateString(value);
  }

  defaultMessage(): string {
    return '$property 需为合法的 YYYY-MM-DD 日期';
  }
}

const IsIsoDate = (): PropertyDecorator => Validate(IsoDateConstraint);

/** 日期区间过滤（UTC 自然日，**含当日**）—— 管理端最常用的是"查某天的数据" */
class DateRangeDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '起始日 YYYY-MM-DD（UTC，含当日）', example: '2026-10-01' })
  @IsOptional()
  @IsIsoDate()
  start_date?: string;

  @ApiPropertyOptional({ description: '结束日 YYYY-MM-DD（UTC，含当日）', example: '2026-10-10' })
  @IsOptional()
  @IsIsoDate()
  end_date?: string;
}

/** 管理端流水列表（前端需求清单 P0 #1）：在用户端字段基础上补 username / user_balance_cents */
export class AdminTransactionQueryDto extends DateRangeDto {
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

  @ApiPropertyOptional({ description: '按用户 ID 精确过滤（UUID）', example: '01a11e65-3a34-7578-95a7-ebfdd8cd731c' })
  @IsOptional()
  @IsString()
  @MaxLength(36)
  user_id?: string;

  @ApiPropertyOptional({ description: '按用户名 / 手机号模糊匹配', example: 'pf_511' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;
}

/** 管理端用户查询（前端需求清单 P0 #2）：只列普通用户，管理员走 /admin/admins */
export class AdminUserQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '按用户名 / 手机号模糊匹配', example: '13800' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({ description: '状态过滤', enum: [0, 1], example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1], { message: 'status 只能是 0正常 1禁用' })
  status?: number;
}

/** 启用/禁用用户（前端需求清单 P0 #3+#4 合并为一个状态接口） */
export class UserStatusDto {
  @ApiProperty({ description: '0 恢复 / 1 禁用', enum: [0, 1], example: 1 })
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1], { message: 'status 只能是 0恢复 1禁用' })
  status!: number;

  @ApiPropertyOptional({ description: '原因（建议填写，会写入审计日志）', example: '违规使用' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;
}

/** 操作日志查询（前端需求清单 P0 #5） */
export class AuditLogQueryDto extends DateRangeDto {
  @ApiPropertyOptional({ description: '操作人（用户名模糊匹配，或用户 ID 精确匹配）', example: 'admin' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  operator?: string;

  @ApiPropertyOptional({
    description: '操作类型',
    enum: [
      'recharge_confirm',
      'recharge_reject',
      'user_disable',
      'user_enable',
      'admin_create',
      'admin_disable',
      'admin_enable',
      'admin_password_reset',
      'password_change',
      'transaction_export',
      'reconciliation_run',
      'wallet_adjust',
      'system_bootstrap',
    ],
    example: 'recharge_confirm',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  action?: string;

  @ApiPropertyOptional({ description: '操作对象（如 apply:27 / user:01a1...，模糊匹配）', example: 'apply:' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  target?: string;
}

/** 创建管理员（前端需求清单：管理员管理页） */
export class CreateAdminDto {
  @ApiProperty({ description: '用户名：4-32 位，字母/数字/下划线', example: 'ops_luobo' })
  @IsString()
  @MinLength(4)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'username 只能是字母、数字、下划线' })
  username!: string;

  @ApiProperty({ description: '密码：8-64 位，需同时包含字母和数字', example: 'Portal2026Admin' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, { message: 'password 至少包含字母和数字' })
  password!: string;

  @ApiPropertyOptional({ description: '手机号（可选）', example: '13800000000' })
  @IsOptional()
  @Matches(/^1[3-9]\d{9}$/, { message: 'phone 需为大陆 11 位手机号' })
  phone?: string;
}

/** 重置某管理员密码（管理员操作他人） */
export class ResetPasswordDto {
  @ApiProperty({ description: '新密码：8-64 位，需同时包含字母和数字', example: 'NewPortal2026' })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, { message: 'new_password 至少包含字母和数字' })
  new_password!: string;
}
