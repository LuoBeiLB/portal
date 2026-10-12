import { Column, Entity, PrimaryColumn } from 'typeorm';

import { WalletStatus } from '../../user/entities/user-status.enum';

/**
 * w_wallet 钱包（与 u_user 1:1，注册即建，balance_cents 初始 0）。
 *
 * 扣费纪律（契约 §0.5）：一律走**条件原子更新**
 *   UPDATE w_wallet SET balance_cents = balance_cents - ?
 *    WHERE user_id = ? AND status = 0 AND balance_cents >= ?
 * 影响行数 = 0 即余额不足或冻结；天然防并发超扣，产品侧无需加锁。
 * 因此这里**不使用 version 乐观锁列**，避免与原子更新语义重复。
 */
@Entity('w_wallet')
export class WalletEntity {
  @PrimaryColumn({ name: 'user_id', type: 'char', length: 36, comment: '= u_user.id（1:1）' })
  userId!: string;

  @Column({ name: 'balance_cents', type: 'bigint', comment: '余额，单位：分，恒 >= 0' })
  balanceCents!: string;

  @Column({
    name: 'status',
    type: 'smallint',
    default: WalletStatus.NORMAL,
    comment: '0 正常 1 冻结',
  })
  status!: WalletStatus;

  @Column({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt!: Date;
}
