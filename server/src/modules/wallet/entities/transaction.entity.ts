import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 流水类型（契约 §3.2）：1 充值 2 扣费 3 退款 4 调账 */
export enum TransactionType {
  RECHARGE = 1,
  DEDUCT = 2,
  REFUND = 3,
  ADJUST = 4,
}

/**
 * w_transaction 资金流水 —— **对账唯一依据**，只增不改不删。
 *
 * 幂等纪律（契约 §0.5）：`bill_no` 全局唯一，重复提交返回首次结果
 * （响应带 `idempotent_repeated: true`），不重复扣费。
 */
@Entity('w_transaction')
@Index('uk_txn_bill_no', ['billNo'], { unique: true })
@Index('idx_txn_user_created', ['userId', 'createdAt'])
@Index('idx_txn_refund_of', ['refundOfBillNo'])
export class TransactionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'user_id', type: 'char', length: 36 })
  userId!: string;

  @Column({ name: 'type', type: 'tinyint', comment: '1 充值 2 扣费 3 退款 4 调账' })
  type!: TransactionType;

  @Column({ name: 'amount_cents', type: 'bigint', comment: '正数，方向由 type 决定' })
  amountCents!: string;

  @Column({ name: 'balance_after', type: 'bigint', comment: '本次流水完成后的余额快照' })
  balanceAfter!: string;

  @Column({
    name: 'bill_no',
    type: 'varchar',
    length: 64,
    comment: '幂等键：产品扣费账单号 / 充值单号 / 退款单号',
  })
  billNo!: string;

  @Column({
    name: 'refund_of_bill_no',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '退款流水指向的原扣费 bill_no，支撑「累计退款 <= 原额」校验（契约 3004）',
  })
  refundOfBillNo!: string | null;

  @Column({
    name: 'product_code',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: 'storage / phone / desktop；门户内部流水（充值、调账）为 NULL',
  })
  productCode!: string | null;

  @Column({ name: 'detail', type: 'json', nullable: true, comment: '账单明细，产品传入时原样入' })
  detail!: Record<string, unknown> | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt!: Date;
}
