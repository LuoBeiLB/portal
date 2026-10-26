import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import { UserRole, UserStatus, UserType } from './user-status.enum';

/**
 * u_user 门户用户（普通用户与管理员**同一张表**，用 `role` 区分）。
 *
 * 主键用 UUIDv7 的 CHAR(36) 形态：JWT 的 `sub`、产品侧 `portal_user_map.portal_user_id`
 * 全链路都是这 36 位字符串，零转换成本（契约 §0.3 / §5.2）。
 *
 * 管理员复用本表的原因：登录、argon2id 密码、JWT、refresh、限流全都现成；
 * 且审计日志的 `operator_id` 能直接指向一个真实的 `u_user.id`，
 * 不像静态 `X-Admin-Key` 那样无法区分操作人（该方案已于 2026-10-10 废弃）。
 */
@Entity('u_user')
@Index('uk_user_username', ['username'], { unique: true })
@Index('uk_user_phone', ['phone'], { unique: true })
@Index('idx_user_role_status', ['role', 'status'])
export class UserEntity {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36, comment: 'UUIDv7，即 JWT 的 sub' })
  id!: string;

  @Column({ name: 'username', type: 'varchar', length: 64, comment: '4-32 位 ^[a-zA-Z0-9_]+$' })
  username!: string;

  @Column({ name: 'phone', type: 'varchar', length: 20, nullable: true, comment: '大陆手机号 11 位' })
  phone!: string | null;

  @Column({ name: 'password_hash', type: 'varchar', length: 100, comment: 'argon2id' })
  passwordHash!: string;

  @Column({
    name: 'role',
    type: 'varchar',
    length: 16,
    default: UserRole.USER,
    comment: 'user 普通用户 / admin 管理员（注册接口写死 user，不接受请求体传入）',
  })
  role!: UserRole;

  /**
   * 账号性质（2026-10-19 新增）：0 个人 / 1 企业员工。
   *
   * 与 `role` 正交，**不是**权限维度。企业员工不能自助充值、不能下单。
   */
  @Column({
    name: 'user_type',
    type: 'tinyint',
    default: UserType.PERSONAL,
    comment: '0 个人 / 1 企业员工（注册接口写死 0，不接受请求体传入）',
  })
  userType!: UserType;

  /**
   * 所属企业（2026-10-19 新增）。**企业归属的权威来源在门户**，
   * 产品侧只按 JWT 的 `ent` 建租户上下文，不存真值。
   *
   * 组合约束（DB CHECK 兜底，见迁移 1760000000000-EnterpriseAccounts）：
   * `user_type=1` ⇒ 非空；`user_type=0` ⇒ 为空。
   */
  @Column({
    name: 'enterprise_id',
    type: 'bigint',
    unsigned: true,
    nullable: true,
    comment: '所属企业；user_type=1 时必填，user_type=0 时必须为空',
  })
  enterpriseId!: string | null;

  @Column({
    name: 'status',
    type: 'smallint',
    default: UserStatus.NORMAL,
    comment: '0 正常 1 禁用',
  })
  status!: UserStatus;

  /**
   * 首登必须改密（2026-10-19 新增）。
   *
   * 企业管理员给员工建号时发的是**初始密码**，首次登录必须自行修改；改密成功后清零。
   */
  @Column({
    name: 'must_change_password',
    type: 'tinyint',
    default: 0,
    comment: '1 首登必须改密（企业管理员建号时置 1，改密成功后清零）',
  })
  mustChangePassword!: number;

  @Column({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt!: Date;

  @Column({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt!: Date;
}
