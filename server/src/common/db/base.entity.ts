import { Column, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 自增 bigint 主键 + 毫秒精度时间戳的通用基类。
 *
 * **时间列由 MySQL 生成**（2026-10-12 统一口径）：用显式 `@Column` +
 * `default: () => 'CURRENT_TIMESTAMP(3)'`，而不是 `@CreateDateColumn`。
 *
 * 为什么不能用 `@CreateDateColumn`：它会让 TypeORM **总是自己写值**（序列化成 UTC 墙面时间），
 * 与库生成列（本地墙面时间）混在一起，同一行里会差 8 小时。
 * 换成显式声明后，应用不传值时 TypeORM 生成 `DEFAULT`，由库填 —— 全库一个口径。
 *
 * ⚠️ 注意：库生成的是**本地墙面时间**（会话时区 `SYSTEM`），
 * 前端展示时**不要再做 UTC→本地转换**（会多 8 小时）。详见 `docs/09-契约v1.1差异与补充.md`。
 */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '自增主键' })
  id!: string;

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

/** readonly 查询基类（`db_readonly` 连接使用） */
export abstract class BaseReadonlyEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;
}
