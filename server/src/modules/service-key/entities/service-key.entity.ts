import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 门户自己的 owner_code 常量（其余为产品 code） */
export const PORTAL_OWNER = 'portal';

/** 公钥启用状态 */
export const SERVICE_KEY_ENABLED = 0;
export const SERVICE_KEY_DISABLED = 1;

/**
 * 服务凭据公钥（`p_service_key`）。对应 `docs/27` §2.4。
 *
 * ## 一张表管两个方向
 *
 * | `owner_code` | 用途 | 谁查 |
 * |---|---|---|
 * | `portal` | 产品验门户签的 token | 门户 JWKS 端点输出 |
 * | 产品 code | 门户验产品签的 token | 内网入站守卫 |
 *
 * ## 为什么一个主体可以有多行
 *
 * 轮换期新旧公钥必须并存：旧 token 还没过期、新 token 已经在签。
 * 用 `status` + `not_before` / `not_after` 表达三种退役方式
 * （手动止血、预发布、到期自动）。
 */
@Entity('p_service_key')
@Index('uk_kid', ['kid'], { unique: true })
@Index('idx_owner_status', ['ownerCode', 'status'])
export class ServiceKeyEntity {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint', unsigned: true })
  id!: string;

  @Column({ name: 'owner_code', type: 'varchar', length: 32, comment: 'portal / storage / phone / desktop' })
  ownerCode!: string;

  @Column({ name: 'kid', type: 'varchar', length: 64, comment: 'JWT header 的 kid，全局唯一' })
  kid!: string;

  @Column({ name: 'public_key_pem', type: 'text', comment: 'SPKI 公钥 PEM' })
  publicKeyPem!: string;

  @Column({ name: 'status', type: 'tinyint', default: 0, comment: '0 启用 / 1 停用' })
  status!: number;

  @Column({ name: 'not_before', type: 'datetime', precision: 3, nullable: true, comment: '生效时间' })
  notBefore!: Date | null;

  @Column({ name: 'not_after', type: 'datetime', precision: 3, nullable: true, comment: '失效时间' })
  notAfter!: Date | null;

  @Column({ name: 'remark', type: 'varchar', length: 255, nullable: true, comment: '谁申请的、为什么轮换' })
  remark!: string | null;

  @Column({ name: 'created_at', type: 'datetime', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  createdAt!: Date;
}