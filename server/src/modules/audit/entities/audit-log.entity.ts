import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 审计动作枚举（`a_audit_log.action`）。
 *
 * 只记**写操作**与**数据导出**：读接口不记，否则日志会被列表查询刷满，
 * 真正要追责的资金/权限操作反而被埋掉。
 */
export enum AuditAction {
  /** 核销充值到账 */
  RECHARGE_CONFIRM = 'recharge_confirm',
  /** 驳回充值 */
  RECHARGE_REJECT = 'recharge_reject',
  /** 禁用普通用户 */
  USER_DISABLE = 'user_disable',
  /** 恢复普通用户 */
  USER_ENABLE = 'user_enable',
  /** 创建管理员 */
  ADMIN_CREATE = 'admin_create',
  /** 禁用管理员 */
  ADMIN_DISABLE = 'admin_disable',
  /** 启用管理员 */
  ADMIN_ENABLE = 'admin_enable',
  /** 管理员重置他人密码 */
  ADMIN_PASSWORD_RESET = 'admin_password_reset',
  /** 用户改自己的密码 */
  PASSWORD_CHANGE = 'password_change',
  /** 导出流水 CSV（数据外泄面，必须留痕） */
  TRANSACTION_EXPORT = 'transaction_export',
  /** 手动触发对账（补跑/排障） */
  RECONCILIATION_RUN = 'reconciliation_run',
  /** 人工调账（第二批实现） */
  WALLET_ADJUST = 'wallet_adjust',
  /* ── 企业（2026-10-19 新增，见 docs/24 M1）── */
  /** 建企业（流程①） */
  ENTERPRISE_CREATE = 'enterprise_create',
  /** 指定 / 移交企业所有者（流程②） */
  ENTERPRISE_OWNER_ASSIGN = 'enterprise_owner_assign',
  /** 管理端把已有账号分配 / 调整企业 */
  ENTERPRISE_USER_ASSIGN = 'enterprise_user_assign',
  /** 审核通过企业注册 */
  ENTERPRISE_APPROVE = 'enterprise_approve',
  /** 驳回企业注册（含原因） */
  ENTERPRISE_REJECT = 'enterprise_reject',
  /** 停用 / 恢复企业 */
  ENTERPRISE_STATUS_CHANGE = 'enterprise_status_change',
  /** 企业管理员建本企业员工（流程③） */
  ENTERPRISE_USER_CREATE = 'enterprise_user_create',
  /** 企业内重置员工密码 */
  ENTERPRISE_USER_PASSWORD_RESET = 'enterprise_user_password_reset',

  /** 系统自动动作（如环境变量 bootstrap 建首个管理员） */
  SYSTEM_BOOTSTRAP = 'system_bootstrap',
}

/**
 * a_audit_log 操作审计日志（2026-10-10 新增）。
 *
 * **为什么必须有**：核销充值、禁用用户、重置密码都是资金/权限操作，出问题要能追到人。
 * 在废弃静态 `X-Admin-Key` 之前，日志里的"经办人"由前端自报（`?admin_id=`），**完全不可信**；
 * 现在 `operator_id` 一律取自**已验证的 JWT**，前端传什么都不影响。
 *
 * 只增不改不删（与 `w_transaction` 同性质）。
 */
@Entity('a_audit_log')
@Index('idx_audit_action_created', ['action', 'createdAt'])
@Index('idx_audit_operator_created', ['operatorId', 'createdAt'])
export class AuditLogEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  /**
   * 操作人 `u_user.id`。
   * 系统动作（bootstrap）记为 `'system'`，因此这里是 VARCHAR 而不是 CHAR(36)。
   */
  @Column({ name: 'operator_id', type: 'varchar', length: 64, comment: "操作人 u_user.id；系统动作为 'system'" })
  operatorId!: string;

  @Column({ name: 'operator', type: 'varchar', length: 64, comment: '冗余用户名，便于展示与留存' })
  operator!: string;

  @Column({ name: 'action', type: 'varchar', length: 32, comment: '见 AuditAction 枚举' })
  action!: string;

  @Column({ name: 'target', type: 'varchar', length: 64, nullable: true, comment: '如 apply:27 / user:01a1...' })
  target!: string | null;

  @Column({ name: 'detail', type: 'json', nullable: true, comment: '可读明细，前端自适应渲染' })
  detail!: Record<string, unknown> | null;

  @Column({ name: 'ip', type: 'varchar', length: 45, nullable: true, comment: '客户端 IP（IPv6 最长 45）' })
  ip!: string | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt!: Date;
}

/** 管理端审计日志列表项（`created_at` 已转成 UTC ISO 字符串） */
export interface AuditLogView {
  id: string;
  operator_id: string;
  operator: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
}
