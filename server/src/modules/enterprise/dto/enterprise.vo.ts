import { ApiProperty } from '@nestjs/swagger';

import { PageView } from '../../../common/dto/common.vo';
import { EnterpriseStatus } from '../entities/enterprise.entity';

/**
 * 企业列表项 / 详情。
 *
 * `owner_user_id` 为空 = 还是 `pending`（没指定所有者，任何人不能用）。
 */
export class EnterpriseView {
  @ApiProperty({ description: '企业 id（**string**）', example: '1' })
  id!: string;

  @ApiProperty({ description: '企业编码', example: 'acme' })
  code!: string;

  @ApiProperty({ description: '企业名称', example: '云存储公司' })
  name!: string;

  @ApiProperty({
    description: '状态：`pending` 待指定所有者（不可用）· `active` 正常 · `disabled` 已停用',
    enum: Object.values(EnterpriseStatus),
    example: EnterpriseStatus.ACTIVE,
  })
  status!: EnterpriseStatus;

  @ApiProperty({ description: '企业总配额（字节，0 = 不限）', example: '1099511627776' })
  quota_bytes!: string;

  @ApiProperty({
    description: '企业所有者 `u_user.id`；`null` 表示还没有所有者（企业不可用）',
    type: String,
    nullable: true,
    example: '01a123fc-c68a-762c-ac55-de911541ab67',
  })
  owner_user_id!: string | null;

  @ApiProperty({ description: '服务到期时间（UTC ISO 8601）；无到期时间为 null', type: String, nullable: true })
  expire_at!: string | null;

  @ApiProperty({ description: '创建时间（UTC ISO 8601）', example: '2026-10-19T02:00:00Z' })
  created_at!: string;
}

/** 企业列表响应 data */
export class EnterpriseListView extends PageView {
  @ApiProperty({ description: '企业列表', type: [EnterpriseView] })
  list!: EnterpriseView[];
}

/** 指定 / 移交所有者结果 */
export class OwnerAssignedView {
  @ApiProperty({ description: '固定 `true`', example: true })
  ok!: boolean;

  @ApiProperty({ description: '企业 id', example: '1' })
  enterprise_id!: string;

  @ApiProperty({ description: '变更后的状态：正常情况下为 `active`', enum: Object.values(EnterpriseStatus) })
  status!: EnterpriseStatus;

  @ApiProperty({ description: '新的所有者 `u_user.id`', example: '01a123fc-c68a-762c-ac55-de911541ab67' })
  owner_user_id!: string;

  @ApiProperty({
    description: '是否为「移交」（企业原来已有所有者）。`false` 表示首次指定',
    example: false,
  })
  transferred!: boolean;

  @ApiProperty({
    description: '本次被吊销的会话数（**换所有者后旧所有者必须重登**）',
    example: 1,
  })
  revoked_sessions!: number;
}

/** 企业员工列表项 */
export class EnterpriseUserView {
  @ApiProperty({ description: '用户 id', example: '01a11e65-3a34-7578-95a7-ebfdd8cd731c' })
  id!: string;

  @ApiProperty({ description: '登录账号', example: 'liming' })
  username!: string;

  @ApiProperty({ type: String, description: '手机号；未绑定时为 null', nullable: true, example: '13800000001' })
  phone!: string | null;

  @ApiProperty({ description: '状态：`0` 正常 · `1` 禁用', enum: [0, 1], example: 0 })
  status!: number;

  @ApiProperty({ description: '是否为该企业所有者', example: false })
  is_owner!: boolean;

  @ApiProperty({
    description: '是否首次登录必须改密（企业管理员建的号初始为 `true`）',
    example: true,
  })
  must_change_password!: boolean;

  @ApiProperty({ description: '创建时间（UTC ISO 8601）', example: '2026-10-19T02:00:00Z' })
  created_at!: string;
}

/** 企业员工列表响应 data */
export class EnterpriseUserListView extends PageView {
  @ApiProperty({ description: '员工列表', type: [EnterpriseUserView] })
  list!: EnterpriseUserView[];
}

/**
 * 新建员工结果。
 *
 * `initial_password` **只在这一次返回**，之后任何接口都查不到 —— 服务端只存 argon2id 哈希。
 * 前端必须引导管理员当场抄下来或复制，刷新页面就没了。
 */
export class EnterpriseUserCreatedView {
  @ApiProperty({ description: '新建用户 id', example: '01a11e65-3a34-7578-95a7-ebfdd8cd731c' })
  id!: string;

  @ApiProperty({ description: '登录账号', example: 'liming' })
  username!: string;

  @ApiProperty({ description: '所属企业 id（**由登录态决定，不来自请求体**）', example: '1' })
  enterprise_id!: string;

  @ApiProperty({ description: '初始密码（仅本次返回）', example: 'Kx7m-Pq2Rt' })
  initial_password!: string;

  @ApiProperty({ description: '首次登录是否必须改密；新建企业员工固定为 `true`', example: true })
  must_change_password!: boolean;
}

/** 企业内重置员工密码结果 */
export class EnterpriseUserPasswordResetView {
  @ApiProperty({ description: '固定 `true`', example: true })
  ok!: boolean;

  @ApiProperty({ description: '重置后的初始密码（仅本次返回）', example: 'Kx7m-Pq2Rt' })
  initial_password!: string;

  @ApiProperty({ description: '首次登录是否必须改密；固定为 `true`', example: true })
  must_change_password!: boolean;

  @ApiProperty({ description: '本次被吊销的会话数（该员工所有设备强制重登）', example: 2 })
  revoked_sessions!: number;
}

/** 企业内停用 / 恢复员工的结果 */
export class EnterpriseUserStatusView {
  @ApiProperty({ description: '固定 `true`', example: true })
  ok!: boolean;

  @ApiProperty({ description: '变更后的状态：`0` 正常 · `1` 禁用', enum: [0, 1], example: 1 })
  status!: number;

  @ApiProperty({ description: '本次被吊销的会话数（禁用会强制下线；启用不恢复登录态）', example: 2 })
  revoked_sessions!: number;

  @ApiProperty({
    description: '目标是否为企业所有者。所有者**不允许被停用**（服务端会拒绝），所以正常返回时为 `false`',
    example: false,
  })
  is_owner!: boolean;
}