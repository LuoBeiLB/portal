import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * p_product_sync_log 商品目录同步日志。
 *
 * 用途：契约承诺「产品调价后最迟 10 分钟生效」，这张表是排查"为什么没生效"的唯一证据链
 * （哪一轮拉的、拉了几条、up 了几条、下架了几条、失败原因）。
 */
@Entity('p_product_sync_log')
@Index('idx_sync_product_started', ['productCode', 'startedAt'])
export class ProductSyncLogEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'product_code', type: 'varchar', length: 32 })
  productCode!: string;

  @Column({ name: 'started_at', type: 'datetime', precision: 3 })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'datetime', precision: 3, nullable: true })
  finishedAt!: Date | null;

  @Column({ name: 'fetched_count', type: 'int', default: 0, comment: '本次拉到条数' })
  fetchedCount!: number;

  @Column({ name: 'upserted_count', type: 'int', default: 0, comment: '新增/更新条数' })
  upsertedCount!: number;

  @Column({ name: 'deactivated_count', type: 'int', default: 0, comment: '本次被软下架条数' })
  deactivatedCount!: number;

  @Column({ name: 'status', type: 'tinyint', default: 0, comment: '0 成功 1 失败' })
  status!: number;

  @Column({ name: 'error_msg', type: 'varchar', length: 512, nullable: true })
  errorMsg!: string | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt!: Date;
}
