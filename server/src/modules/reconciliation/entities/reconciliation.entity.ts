import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * r_reconciliation 日对账结果（契约 §6 `GET /admin/reconciliation/daily`）。
 *
 * 对账口径：**产品账单 vs 门户流水**。差异落库，供管理端展示与人工修复。
 * 本期对账数据来源 = 门户 `w_transaction` + 各产品 `b_bill`（产品侧另行导出，门户不直连产品库）。
 */
@Entity('r_reconciliation')
@Index('uk_recon_date_product', ['bizDate', 'productCode'], { unique: true })
export class ReconciliationEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'biz_date', type: 'date', comment: '对账业务日' })
  bizDate!: string;

  @Column({ name: 'product_code', type: 'varchar', length: 32 })
  productCode!: string;

  @Column({ name: 'portal_amount_cents', type: 'bigint', default: 0, comment: '门户侧当日金额合计（分）' })
  portalAmountCents!: string;

  @Column({ name: 'product_amount_cents', type: 'bigint', default: 0, comment: '产品侧当日金额合计（分）' })
  productAmountCents!: string;

  @Column({ name: 'diff_cents', type: 'bigint', default: 0, comment: '差异金额（分）' })
  diffCents!: string;

  @Column({ name: 'diff_count', type: 'int', default: 0, comment: '差异笔数' })
  diffCount!: number;

  @Column({ name: 'detail', type: 'json', nullable: true, comment: '差异明细（bill_no 列表等）' })
  detail!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}
