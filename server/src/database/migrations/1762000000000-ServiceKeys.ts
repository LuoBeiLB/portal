import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 服务凭据公钥表（2026-10-27）。对应 `docs/27` §2.4。
 *
 * ## 为什么需要这张表
 *
 * 改造前服务间用 `X-Internal-Key` 静态共享密钥，两个方向共用同一把，泄漏即双向通吃。
 * 改造后两个方向都改用 RS256：**私钥留在各自服务的文件里，所有公钥集中到这张表**。
 *
 * 为什么公钥能进库、私钥不能：公钥本来就公开（门户 JWKS 挂在可访问路径），
 * 落库只涉及"防篡改"；私钥进库会被备份、慢日志、只读副本扩散。
 *
 * ## 为什么不是配置文件
 *
 * 文件方案做不好三件事：加产品要重启、泄漏止血要重启（打断所有调用）、
 * 轮换需要新旧公钥并存。更要紧的是**轮换没法拆两步**——
 * 正常顺序是"先让验签方拿到新公钥，再切私钥"，文件方案把这两件事绑在同一次重启上。
 *
 * ## 数据从哪来
 *
 * 迁移**只建表不插数据**：`portal` 行由 `ServiceKeyService.ensurePortalKey()`
 * 在启动时用私钥派生的公钥自动写入（避免迁移脚本依赖密钥文件）；
 * 产品公钥由运维 SQL 插入。
 */
export class ServiceKeys1762000000000 implements MigrationInterface {
  name = 'ServiceKeys1762000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const exists = (await queryRunner.query(
      `SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'p_service_key' LIMIT 1`,
    )) as unknown[];
    if (exists.length > 0) return;

    await queryRunner.query(`
      CREATE TABLE p_service_key (
        id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        owner_code     VARCHAR(32)   NOT NULL COMMENT '谁的密钥：portal / storage / phone / desktop',
        kid            VARCHAR(64)   NOT NULL COMMENT 'JWT header 的 kid，全局唯一',
        public_key_pem TEXT          NOT NULL COMMENT 'SPKI 公钥 PEM（公钥不是秘密，可落库）',
        status         TINYINT       NOT NULL DEFAULT 0 COMMENT '0 启用 / 1 停用',
        not_before     DATETIME(3)   NULL COMMENT '生效时间',
        not_after      DATETIME(3)   NULL COMMENT '失效时间',
        remark         VARCHAR(255)  NULL COMMENT '谁申请的、为什么轮换',
        created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uk_kid (kid),
        KEY idx_owner_status (owner_code, status)
      ) ENGINE=InnoDB COMMENT='服务凭据公钥（双向验签共用一张表）'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS p_service_key`);
  }
}