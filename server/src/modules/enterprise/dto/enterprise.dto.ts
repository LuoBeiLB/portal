import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { EnterpriseStatus } from '../entities/enterprise.entity';

const CODE_RULE = /^[a-zA-Z0-9_-]+$/;
const USERNAME_RULE = /^[a-zA-Z0-9_]+$/;
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).+$/;
const PHONE_RULE = /^1[3-9]\d{9}$/;

/**
 * 企业自助注册（**C 端，免登录**，对应 docs/23 图①）。
 *
 * 一次提交同时建出：企业（`pending`）+ 企业管理员账号 + 钱包。
 * 所以这里既要企业信息，也要管理员登录凭据。
 */
export class RegisterEnterpriseDto {
  @ApiProperty({ description: '企业编码，唯一、建好后不可改', example: 'acme2026', maxLength: 64 })
  @IsString()
  @IsNotEmpty({ message: '企业编码不能为空' })
  @Length(2, 64)
  @Matches(CODE_RULE, { message: '企业编码只允许字母、数字、下划线和短横线' })
  code!: string;

  @ApiProperty({ description: '企业名称', example: '某某科技有限公司', maxLength: 128 })
  @IsString()
  @IsNotEmpty({ message: '企业名称不能为空' })
  @Length(1, 128)
  name!: string;

  @ApiPropertyOptional({ description: '注册联系人', example: '张三', maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(0, 64)
  contact_name?: string;

  @ApiPropertyOptional({ description: '注册联系电话（也会作为管理员账号的手机号）', example: '13800000000' })
  @IsOptional()
  @Matches(PHONE_RULE, { message: '手机号格式不正确' })
  contact_phone?: string;

  @ApiPropertyOptional({ description: '注册备注（企业方填写，供审核参考）', example: '因业务拓展申请开通', maxLength: 255 })
  @IsOptional()
  @IsString()
  @Length(0, 255)
  remark?: string;

  @ApiProperty({
    description: '企业管理员登录账号。与 C 端个人用户**共用命名空间**，全库唯一',
    example: 'acme_admin',
    maxLength: 32,
  })
  @IsString()
  @IsNotEmpty({ message: '管理员账号不能为空' })
  @Length(4, 32, { message: '管理员账号长度 4-32 位' })
  @Matches(USERNAME_RULE, { message: '管理员账号只允许字母、数字和下划线' })
  admin_username!: string;

  @ApiProperty({
    description: '企业管理员密码，8-64 位且至少含字母和数字',
    example: 'Abc123456',
    maxLength: 64,
    minLength: 8,
  })
  @IsString()
  @Length(8, 64)
  @Matches(PASSWORD_RULE, { message: '密码至少包含字母和数字' })
  admin_password!: string;
}

/** 管理端代客建企业（后台兜底，前端不给入口） */
export class CreateEnterpriseDto {
  @ApiProperty({ description: '企业编码，唯一、建好后不可改', example: 'acme', maxLength: 64 })
  @IsString()
  @IsNotEmpty({ message: '企业编码不能为空' })
  @Length(2, 64)
  @Matches(CODE_RULE, { message: '企业编码只允许字母、数字、下划线和短横线' })
  code!: string;

  @ApiProperty({ description: '企业名称', example: '云存储公司', maxLength: 128 })
  @IsString()
  @IsNotEmpty({ message: '企业名称不能为空' })
  @Length(1, 128)
  name!: string;

  @ApiPropertyOptional({ description: '注册联系人', example: '张三' })
  @IsOptional()
  @IsString()
  @Length(0, 64)
  contact_name?: string;

  @ApiPropertyOptional({ description: '注册联系电话', example: '13800000000' })
  @IsOptional()
  @Matches(PHONE_RULE, { message: '手机号格式不正确' })
  contact_phone?: string;

  @ApiPropertyOptional({ description: '备注', example: '大客户，平台代开' })
  @IsOptional()
  @IsString()
  @Length(0, 255)
  remark?: string;

  @ApiPropertyOptional({ description: '服务到期时间（ISO 8601），可空', example: '2027-10-19T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  expire_at?: string;
}

/** 企业列表 / 审核列表查询 */
export class EnterpriseQueryDto {
  @ApiPropertyOptional({ description: '按企业编码或名称模糊搜索' })
  @IsOptional()
  @IsString()
  @Length(0, 64)
  keyword?: string;

  @ApiPropertyOptional({
    description: '状态筛选。审核页用 `pending`',
    enum: Object.values(EnterpriseStatus),
    example: EnterpriseStatus.PENDING,
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

/** 审核驳回（**原因必填**，登录时会回显给企业方） */
export class RejectEnterpriseDto {
  @ApiProperty({
    description: '驳回原因。必填，最长 255 字，会原样出现在企业方登录失败的 message 里',
    example: '资料不全，请补充营业执照',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty({ message: '驳回必须填写原因' })
  @Length(1, 255)
  reason!: string;
}

/** 停用 / 恢复企业（运营动作） */
export class EnterpriseStatusDto {
  @ApiProperty({
    description: '目标状态：`active` 恢复 · `disabled` 停用（`pending` 请走审核接口）',
    enum: [EnterpriseStatus.ACTIVE, EnterpriseStatus.DISABLED],
    example: EnterpriseStatus.DISABLED,
  })
  @IsIn([EnterpriseStatus.ACTIVE, EnterpriseStatus.DISABLED])
  status!: EnterpriseStatus;
}

/** 指定 / 移交主管理员 */
export class AssignOwnerDto {
  @ApiProperty({
    description: '目标账号 `u_user.id`（UUID36）。必须是本企业成员或可转为成员的账号；不能是平台管理员',
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
 * 企业管理员建本企业员工（docs/23 图③）。
 *
 * ⚠️ **刻意没有 `enterprise_id` 字段**：企业归属由服务端从登录态取。
 * 一旦这里能传，企业管理员就能把员工建到别家企业去。
 */
export class CreateEnterpriseUserDto {
  @ApiProperty({ description: '登录账号（全库唯一，与 C 端共用命名空间）', example: 'liming', maxLength: 32 })
  @IsString()
  @IsNotEmpty({ message: '登录账号不能为空' })
  @Length(4, 32, { message: '登录账号长度 4-32 位' })
  @Matches(USERNAME_RULE, { message: '登录账号只允许字母、数字和下划线' })
  username!: string;

  @ApiPropertyOptional({ description: '手机号（可空）', example: '13800000001' })
  @IsOptional()
  @Matches(PHONE_RULE, { message: '手机号格式不正确' })
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
