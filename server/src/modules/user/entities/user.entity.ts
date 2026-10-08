import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { UserStatus } from './user-status.enum';

/**
 * u_user 门户用户。
 *
 * 主键用 UUIDv7 的 CHAR(36) 形态：JWT 的 `sub`、产品侧 `portal_user_map.portal_user_id`
 * 全链路都是这 36 位字符串，零转换成本（契约 §0.3 / §5.2）。
 */
@Entity('u_user')
@Index('uk_user_username', ['username'], { unique: true })
@Index('uk_user_phone', ['phone'], { unique: true })
export class UserEntity {
  @PrimaryColumn({ name: 'id', type: 'char', length: 36, comment: 'UUIDv7，即 JWT 的 sub' })
  id!: string;

  @Column({ name: 'username', type: 'varchar', length: 64, comment: '4-32 位 ^[a-zA-Z0-9_]+$' })
  username!: string;

  @Column({ name: 'phone', type: 'varchar', length: 20, nullable: true, comment: '大陆手机号 11 位' })
  phone!: string | null;

  @Column({ name: 'password_hash', type: 'varchar', length: 100, comment: 'argon2id' })
  passwordHash!: string;

  @Column({
    name: 'status',
    type: 'smallint',
    default: UserStatus.NORMAL,
    comment: '0 正常 1 禁用',
  })
  status!: UserStatus;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 })
  updatedAt!: Date;
}
