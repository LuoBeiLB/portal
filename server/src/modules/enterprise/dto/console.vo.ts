import { ApiProperty } from '@nestjs/swagger';

import { EnterpriseStatus } from '../entities/enterprise.entity';

/** 管理端会话里的企业摘要（企业视图用） */
export class ConsoleEnterpriseView {
  @ApiProperty({ description: '企业 id', example: '1' })
  id!: string;

  @ApiProperty({ description: '企业编码', example: 'acme2026' })
  code!: string;

  @ApiProperty({ description: '企业名称', example: '某某科技有限公司' })
  name!: string;

  @ApiProperty({ description: '企业状态；能进企业视图时必为 `active`', enum: Object.values(EnterpriseStatus) })
  status!: EnterpriseStatus;

  @ApiProperty({ description: '服务到期时间（UTC ISO 8601），可空', type: String, nullable: true })
  expire_at!: string | null;

  @ApiProperty({ description: '企业成员数（含主管理员）', example: 12 })
  member_count!: number;

  @ApiProperty({ description: '当前账号是否为主管理员（资源持有人/付费方）', example: true })
  is_owner!: boolean;
}

/**
 * `GET /api/console/session` 的响应 —— **进管理端的唯一判据**。
 *
 * 替代 `GET /api/admin/auth/verify`：一次拿到"我是谁、能看什么"，
 * 前端不再靠探测决定分流（v2 §4.4 / §7.1）。
 */
export class ConsoleSessionView {
  @ApiProperty({ description: '当前操作人用户名', example: 'acme_admin' })
  operator!: string;

  @ApiProperty({ description: '当前操作人 `u_user.id`', example: '01a123fc-c68a-762c-ac55-de911541ab67' })
  operator_id!: string;

  @ApiProperty({
    description: '视图范围：`platform` 全平台 · `enterprise` 仅本企业',
    enum: ['platform', 'enterprise'],
    example: 'enterprise',
  })
  scope!: 'platform' | 'enterprise';

  @ApiProperty({
    description: '权限点白名单。前端据此过滤菜单 / 路由 / 按钮，**没列出来的一律不可见**',
    type: [String],
    example: ['enterprise.profile.read', 'enterprise.member.read', 'enterprise.member.write', 'enterprise.member.reset'],
  })
  permissions!: string[];

  @ApiProperty({
    description: '平台管理员为 `null`；企业管理员为企业摘要',
    type: ConsoleEnterpriseView,
    nullable: true,
  })
  enterprise!: ConsoleEnterpriseView | null;

  @ApiProperty({ description: '服务端当前时间（UTC ISO 8601），前端可据此校准', example: '2026-10-27T03:10:30Z' })
  server_time!: string;
}
