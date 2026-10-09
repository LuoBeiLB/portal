import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * r_product_bill_report 产品账单上报（对账的数据来源）。
 *
 * 为什么需要：契约 §6 的日对账是「**产品账单 vs 门户流水**」，但门户**不直连产品库**
 * （契约明确产品库结构自定）。所以产品侧必须把当日账单导出给门户，门户再做比对。
 *
 * 一期由产品侧调 `POST /api/internal/reconciliation/report` 上报；
 * 若产品侧不方便推送，也可以从产品库导出 CSV 后人工喂给对账，两条路都留。
 */
@Entity('r_product_bill_report')
@Index('uk_report_date_product_bill', ['bizDate', 'productCode', 'billNo'], { unique: true })
@Index('idx_report_date_product', ['bizDate', 'productCode'])
export class ProductBillReportEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'biz_date', type: 'date', comment: '账单所属业务日（UTC）' })
  bizDate!: string;

  @Column({ name: 'product_code', type: 'varchar', length: 32 })
  productCode!: string;

  @Column({ name: 'bill_no', type: 'varchar', length: 64, comment: '产品侧账单号' })
  billNo!: string;

  @Column({
    name: 'portal_user_id',
    type: 'char',
    length: 36,
    nullable: true,
    comment: '门户用户 UUID（产品侧影子表里的）',
  })
  portalUserId!: string | null;

  @Column({ name: 'amount_cents', type: 'bigint', comment: '账单金额，单位：分' })
  amountCents!: string;

  @Column({ name: 'type', type: 'tinyint', default: 2, comment: '1 充值 2 扣费 3 退款' })
  type!: number;

  @Column({ name: 'related_bill_no', type: 'varchar', length: 64, nullable: true, comment: '退款时指向的原单' })
  relatedBillNo!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;
}
