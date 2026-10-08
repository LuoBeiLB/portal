import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 充值单状态（契约 §3.3）：0 待核销 1 已到账 2 驳回 */
export enum RechargeStatus {
  PENDING = 0,
  CONFIRMED = 1,
  REJECTED = 2,
}

/**
 * w_recharge_apply 充值申请（人工核销，契约 §3.3 / §6.2）。
 *
 * 一期唯一的入金通道：用户提交申请 → 线下转账 → 管理员核销到账（写 type=1 流水）。
 * 核销必须走**条件更新** `WHERE id = ? AND status = 0`，影响行数 = 0 即"已被处理"，
 * 防止两个管理员同时点通过导致重复增额。
 */
@Entity('w_recharge_apply')
@Index('idx_recharge_status_created', ['status', 'createdAt'])
@Index('idx_recharge_user', ['userId'])
export class RechargeApplyEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'user_id', type: 'char', length: 36 })
  userId!: string;

  @Column({ name: 'amount_cents', type: 'bigint', comment: '100 ~ 10,000,000（分）' })
  amountCents!: string;

  @Column({ name: 'remark', type: 'varchar', length: 255, nullable: true, comment: '转账备注/凭证说明' })
  remark!: string | null;

  @Column({ name: 'status', type: 'smallint', default: RechargeStatus.PENDING, comment: '0 待核销 1 已到账 2 驳回' })
  status!: RechargeStatus;

  @Column({ name: 'reviewed_by', type: 'char', length: 36, nullable: true, comment: '核销管理员 user_id' })
  reviewedBy!: string | null;

  @Column({ name: 'reviewed_at', type: 'datetime', precision: 3, nullable: true })
  reviewedAt!: Date | null;

  @Column({ name: 'reject_reason', type: 'varchar', length: 255, nullable: true })
  rejectReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}
