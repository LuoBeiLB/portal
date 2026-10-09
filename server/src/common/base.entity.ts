import { CreateDateColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * 自增 bigint 主键 + 毫秒精度时间戳的通用基类。
 *
 * 时间列用 `@CreateDateColumn` / `@UpdateDateColumn`，值由 MySQL 生成。
 * ⚠️ 已知问题：MySQL 会话时区为 `SYSTEM`（本机 +08:00）时，生成的是本地墙上时间，
 * 而接口按 UTC 输出，导致时间字段整体偏移。详见 `config/database.options.ts` 顶部的说明。
 */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '自增主键' })
  id!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}

/** readonly 查询基类（`db_readonly` 连接使用） */
export abstract class BaseReadonlyEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;
}
