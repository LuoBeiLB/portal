import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsISO8601,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { EnterpriseStatus } from '../entities/enterprise.entity';

/** 建企业（流程①）。**不建角色** —— 角色模板由云存储侧惰性创建，见 docs/24 §1.3 与 docs/18 §4.2.1 */
export class CreateEnterpriseDto {
  @ApiProperty({ description: '企业编码，对接用；建好后不可改', example: 'acme', maxLength: 64 })
  @IsString()
  @IsNotEmpty({ message: '企业编码不能为空' })
  @Length(2, 64)
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: '企业编码只允许字母、数字、下划线和短横线' })
  code!: string;

  @ApiProperty({ description: '企业名称', example: '云存储公司', maxLength: 128 })
  @IsString()
  @IsNotEmpty({ message: '企业名称不能为空' })
  @Length(1, 128)
  name!: string;

  @ApiPropertyOptional({ description: '企业总配额（字节，0 = 不限），默认 0', example: 1099511627776 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  quota_bytes?: number;

  @ApiPropertyOptional({ description: '服务到期时间（ISO 8601），可空', example: '2027-10-19T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  expire_at?: string;
}

/** 企业列表查询 */
export class EnterpriseQueryDto {
  @ApiPropertyOptional({ description: '按企业编码或名称模糊搜索' })
  @IsOptional()
  @IsString()
  @Length(0, 64)
  keyword?: string;

  @ApiPropertyOptional({
    description: '状态筛选',
    enum: Object.values(EnterpriseStatus),
    example: EnterpriseStatus.ACTIVE,
  })
  @IsOptional()
  @IsIn(Object.values(EnterpriseStatus))
  status?: EnterpriseStatus;

  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数', example: 20, default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size?: number;
}

/**
 * 指定 / 移交企业所有者（流程②）。
 *
 * 只传 `user_id`，**不接受 enterprise_id** —— 路径里已经有了，
 * 而且校验逻辑要读企业本身，没必要让调用方再传一次。
 */
export class AssignOwnerDto {
  @ApiProperty({
    description: '目标账号的 `u_user.id`（UUID36）。必须是本企业员工或可转为员工的个人账号；不能是平台管理员',
    example: '01a123fc-c68a-762c-ac55-de911541ab67',
  })
  @IsString()
  @Length(36, 36, { message: 'user_id 必须是 36 位 UUID' })
  user_id!: string;
}

/** 管理端把已有账号分配 / 调整到某企业 */
export class AssignUserEnterpriseDto {
  @ApiProperty({ description: '目标企业 id（`enterprise.id`）', example: '1' })
  @IsString()
  @IsNotEmpty()
  enterprise_id!: string;
}

/**
 * 企业所有者建本企业员工（流程③）。
 *
 * ⚠️ **刻意没有 `enterprise_id` 字段**：企业归属由服务端从登录态取。
 * 一旦这里能传，企业所有者就能把员工建到别家企业去——最隐蔽的越权点。
 */
export class CreateEnterpriseUserDto {
  @ApiProperty({ description: '登录账号（企业内唯一；全库唯一约束仍在，见契约 §1.1）', example: 'liming', maxLength: 64 })
  @IsString()
  @IsNotEmpty({ message: '登录账号不能为空' })
  @Length(4, 32, { message: '登录账号长度 4-32 位' })
  @Matches(/^[a-zA-Z0-9_]+$/, { message: '登录账号只允许字母、数字和下划线' })
  username!: string;

  @ApiPropertyOptional({ description: '手机号（可空）', example: '13800000001' })
  @IsOptional()
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone?: string;
}

/** 企业员工列表查询 */
export class EnterpriseUserQueryDto {
  @ApiPropertyOptional({ description: '按登录账号或手机号模糊搜索' })
  @IsOptional()
  @IsString()
  @Length(0, 64)
  keyword?: string;

  @ApiPropertyOptional({ description: '页码，从 1 开始', example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: '每页条数', example: 20, default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size?: number;
}

/** 企业内停用 / 恢复员工 */
export class EnterpriseUserStatusDto {
  @ApiProperty({ description: '目标状态：`0` 正常 · `1` 禁用', enum: [0, 1], example: 1 })
  @Type(() => Number)
  @IsInt()
  @IsIn([0, 1])
  status!: number;
}
