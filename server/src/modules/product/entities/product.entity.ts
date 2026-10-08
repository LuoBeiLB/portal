import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** 计费模式（契约 §2.1）：1 包周期（下单即扣） 2 按量（开通 0 元单，后付费由产品出账） */
export enum BillingMode {
  PERIOD = 1,
  USAGE = 2,
}

/**
 * p_product 商品目录缓存 —— 源在产品，门户每 10 分钟全量拉取 upsert（契约 §5.1）。
 *
 * 重要：
 * 1. 下单时以**当前缓存价重算**，不信任前端传入价格；
 * 2. 产品不再上报某 sku 时置 `is_active = 0` 软下架，**不物理删除**，
 *    否则历史订单项按 sku_id 展示时会断档。
 */
@Entity('p_product')
@Index('uk_product_code_sku', ['productCode', 'skuId'], { unique: true })
@Index('idx_product_active', ['productCode', 'isActive'])
export class ProductEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'product_code', type: 'varchar', length: 32, comment: 'storage / phone / desktop' })
  productCode!: string;

  @Column({ name: 'sku_id', type: 'varchar', length: 64, comment: '产品内唯一，变更后旧 id 视为下架' })
  skuId!: string;

  @Column({ name: 'name', type: 'varchar', length: 128, comment: '门户展示名' })
  name!: string;

  @Column({ name: 'spec', type: 'json', nullable: true, comment: '规格结构由产品自定，门户原样展示' })
  spec!: Record<string, unknown> | null;

  @Column({ name: 'price_cents', type: 'int', comment: '单价，单位：分' })
  priceCents!: number;

  @Column({ name: 'billing_mode', type: 'tinyint', default: BillingMode.PERIOD, comment: '1 包周期 2 按量' })
  billingMode!: BillingMode;

  @Column({ name: 'period_days', type: 'int', nullable: true, comment: 'billing_mode=1 必填' })
  periodDays!: number | null;

  @Column({ name: 'stock', type: 'int', nullable: true, comment: 'NULL = 不限或未上报，前端显示「现货」' })
  stock!: number | null;

  @Column({ name: 'is_active', type: 'tinyint', default: 1, comment: '1 在售 0 已下架（软下架）' })
  isActive!: number;

  @Column({ name: 'synced_at', type: 'datetime', precision: 3, comment: '最近一次同步时间' })
  syncedAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
