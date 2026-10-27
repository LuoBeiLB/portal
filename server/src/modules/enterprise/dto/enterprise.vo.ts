import { ApiProperty } from '@nestjs/swagger';

import { PageView } from '../../../common/dto/common.vo';
import { EnterpriseStatus } from '../entities/enterprise.entity';

/**
 * 企业列表项 / 详情。
 *
 * v2 起多出**审核相关字段**：审核页要展示联系人、备注、驳回原因、审核人与时间，
 * 否则平台没法判断该不该通过。
 */
export class EnterpriseView {
  @ApiProperty({ description: '企业 id（**string**）', example: '1' })
  id!: string;

  @ApiProperty({ description: '企业编码', example: 'acme2026' })
  code!: string;

  @ApiProperty({ description: '企业名称', example: '某某科技有限公司' })
  name!: string;

  @ApiProperty({
    description: '状态：`pending` 待审核 · `active` 正常 · `rejected` 已驳回 · `disabled` 已停用',
    enum: Object.values(EnterpriseStatus),
    example: EnterpriseStatus.ACTIVE,
  })
  status!: EnterpriseStatus;

  @ApiProperty({ description: '注册联系人', type: String, nullable: true, example: '张三' })
  contact_name!: string | null;

  @ApiProperty({ description: '注册联系电话', type: String, nullable: true, example: '13800000000' })
  contact_phone!: string | null;

  @ApiProperty({ description: '注册备注（企业方填写）', type: String, nullable: true, example: '因业务拓展申请开通' })
  remark!: string | null;

  @ApiProperty({
    description: '主管理员 `u_user.id`（创建者 / 资源持有人 / 付费方）；`null` 表示尚未回填',
    type: String,
    nullable: true,
    example: '01a123fc-c68a-762c-ac55-de911541ab67',
  })
  owner_user_id!: string | null;

  @ApiProperty({ description: '服务到期时间（UTC ISO 8601）；无到期时间为 null', type: String, nullable: true })
  expire_at!: string | null;

  @ApiProperty({ description: '审核时间；未审核为 null', type: String, nullable: true })
  reviewed_at!: string | null;

  @ApiProperty({ description: '审核人 `u_user.id`；未审核为 null', type: String, nullable: true })
  reviewed_by!: string | null;

  @ApiProperty({ description: '审核人用户名（列表直接展示，省得前端再查）', type: String, nullable: true })
  reviewed_by_username!: string | null;

  @ApiProperty({ description: '驳回原因；仅 `rejected` 状态有值', type: String, nullable: true })
  reject_reason!: string | null;

  @ApiProperty({ description: '企业成员数（含主管理员）', example: 12 })
  member_count!: number;

  @ApiProperty({ description: '创建时间（UTC ISO 8601）', example: '2026-10-27T02:00:00Z' })
  created_at!: string;
}

/** 企业列表响应 data */
export class EnterpriseListView extends PageView {
  @ApiProperty({ description: '企业列表', type: [EnterpriseView] })
  list!: EnterpriseView[];
}

/** 企业自助注册结果 */
export class EnterpriseRegisteredView {
  @ApiProperty({ description: '新建企业 id', example: '1' })
  enterprise_id!: string;

  @ApiProperty({
    description: '固定为 `pending` —— **注册不等于可用**，要等平台审核',
    enum: [EnterpriseStatus.PENDING],
    example: EnterpriseStatus.PENDING,
  })
  status!: EnterpriseStatus;

  @ApiProperty({ description: '同时建出的企业管理员账号', example: 'acme_admin' })
  admin_username!: string;

  @ApiProperty({ description: '给 C 端直接展示的提示语', example: '注册已提交，等待平台审核' })
  message!: string;
}

/** 审核 / 停用启用的结果 */
export class EnterpriseReviewView {
  @ApiProperty({ description: '固定 `true`', example: true })
  ok!: boolean;

  @ApiProperty({ description: '企业 id', example: '1' })
  enterprise_id!: string;

  @ApiProperty({
    description: '变更后的状态',
    enum: Object.values(EnterpriseStatus),
    example: EnterpriseStatus.ACTIVE,
  })
  status!: EnterpriseStatus;
}

/** 指定 / 移交主管理员的结果 */
export class OwnerAssignedView {
  @ApiProperty({ description: '固定 `true`', example: true })
  ok!: boolean;

  @ApiProperty({ description: '企业 id', example: '1' })
  enterprise_id!: string;

  @ApiProperty({ description: '变更后的状态', enum: Object.values(EnterpriseStatus) })
  status!: EnterpriseStatus;

  @ApiProperty({ description: '新的主管理员 `u_user.id`', example: '01a123fc-c68a-762c-ac55-de911541ab67' })
  owner_user_id!: string;

  @ApiProperty({ description: '是否为「移交」（企业原来已有主管理员）', example: false })
  transferred!: boolean;

  @ApiProperty({ description: '本次被吊销的会话数（换人后旧管理员必须重登）', example: 1 })
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

  @ApiProperty({ description: '是否为主管理员（`owner_user_id` 指向他；资源持有人/付费方）', example: false })
  is_owner!: boolean;

  @ApiProperty({
    description: '是否为企业管理员（`enterprise_role = 1`）。**判权看这个**，不看 `is_owner`',
    example: false,
  })
  is_admin!: boolean;

  @ApiProperty({ description: '是否首次登录必须改密', example: true })
  must_change_password!: boolean;

  @ApiProperty({ description: '创建时间（UTC ISO 8601）', example: '2026-10-27T02:00:00Z' })
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

  @ApiProperty({ description: '本次被吊销的会话数', example: 2 })
  revoked_sessions!: number;
}

/** 企业内停用 / 恢复员工的结果 */
export class EnterpriseUserStatusView {
  @ApiProperty({ description: '固定 `true`', example: true })
  ok!: boolean;

  @ApiProperty({ description: '变更后的状态：`0` 正常 · `1` 禁用', enum: [0, 1], example: 1 })
  status!: number;

  @ApiProperty({ description: '本次被吊销的会话数', example: 2 })
  revoked_sessions!: number;

  @ApiProperty({
    description: '目标是否为主管理员。主管理员**不允许被停用**（服务端会拒绝），故正常响应里为 `false`',
    example: false,
  })
  is_owner!: boolean;
}
