import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * r_reconciliation 日对账结果（契约 §6 `GET /admin/reconciliation/daily`）。
 *
 * 对账口径：**产品账单 vs 门户流水**。
 * 门户**不直连产品库**，所以产品侧先把账单上报到 `r_product_bill_report`（见该实体注释），
 * 本表存比对结果：金额差异 + 三类明细（产品多、门户多、金额不符）。
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

  @Column({ name: 'product_only_count', type: 'int', default: 0, comment: '仅产品侧有（门户漏记/未回传）' })
  productOnlyCount!: number;

  @Column({ name: 'portal_only_count', type: 'int', default: 0, comment: '仅门户侧有（产品未上报）' })
  portalOnlyCount!: number;

  @Column({ name: 'amount_mismatch_count', type: 'int', default: 0, comment: '两边都有但金额不一致' })
  amountMismatchCount!: number;

  @Column({ name: 'detail', type: 'json', nullable: true, comment: '差异明细（bill_no 列表等）' })
  detail!: Record<string, unknown> | null;

  @Column({ name: 'status', type: 'varchar', length: 16, default: 'ok', comment: 'ok 平账 / diff 有差异' })
  status!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}
