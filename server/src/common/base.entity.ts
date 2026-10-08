import { CreateDateColumn, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** 自增 bigint 主键 + 毫秒精度时间戳的通用基类 */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '自增主键' })
  id!: string;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3, comment: '创建时间' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3, comment: '更新时间' })
  updatedAt!: Date;
}

/** readonly 查询基类（`db_readonly` 连接使用） */
export abstract class BaseReadonlyEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;
}
