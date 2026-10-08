import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 门户库初始化建表（MySQL 8.0 · 金额一律 store 为「分」）。
 *
 * 依据：[04-门户下一版方案_架构与ER.md] §2 表结构，与《云平台统一门户 API 契约 v1.0》逐条对齐。
 * 说明：
 * - 全库 utf8mb4_0900_ai_ci（MySQL 8 默认排序规则）。
 * - 时间为 DATETIME(3)，应用侧统一按 UTC 存取。
 * - `w_transaction` 只增不改不删，是对账唯一依据。
 * - 门户**不建** `portal_user_map` / `b_bill`：那两张表属于各产品库（跨库，结构由产品自定）。
 */
export class InitPortalSchema1759600000000 implements MigrationInterface {
  name = 'InitPortalSchema1759600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------- u_user ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`u_user\` (
        \`id\`            CHAR(36)     NOT NULL COMMENT 'UUIDv7，即 JWT 的 sub',
        \`username\`      VARCHAR(64)  NOT NULL COMMENT '4-32 位 ^[a-zA-Z0-9_]+$',
        \`phone\`         VARCHAR(20)  NULL COMMENT '大陆手机号 11 位',
        \`password_hash\` VARCHAR(100) NOT NULL COMMENT 'argon2id',
        \`status\`        SMALLINT     NOT NULL DEFAULT 0 COMMENT '0 正常 1 禁用',
        \`created_at\`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updated_at\`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_user_username\` (\`username\`),
        UNIQUE KEY \`uk_user_phone\` (\`phone\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='门户用户';
    `);

    // ---------- w_wallet ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`w_wallet\` (
        \`user_id\`       CHAR(36)    NOT NULL COMMENT '= u_user.id（1:1）',
        \`balance_cents\` BIGINT      NOT NULL DEFAULT 0 COMMENT '余额，单位：分，恒 >= 0',
        \`status\`        SMALLINT    NOT NULL DEFAULT 0 COMMENT '0 正常 1 冻结',
        \`updated_at\`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`user_id\`),
        CONSTRAINT \`fk_wallet_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`u_user\` (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='钱包（注册即建）';
    `);

    // ---------- w_transaction ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`w_transaction\` (
        \`id\`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`user_id\`           CHAR(36)        NOT NULL,
        \`type\`              TINYINT         NOT NULL COMMENT '1 充值 2 扣费 3 退款 4 调账',
        \`amount_cents\`      BIGINT          NOT NULL COMMENT '正数，方向由 type 决定',
        \`balance_after\`     BIGINT          NOT NULL COMMENT '本次流水完成后的余额快照',
        \`bill_no\`           VARCHAR(64)     NOT NULL COMMENT '幂等键：产品账单号 / 充值单号 / 退款单号',
        \`refund_of_bill_no\` VARCHAR(64)     NULL COMMENT '退款流水指向的原扣费 bill_no',
        \`product_code\`      VARCHAR(32)     NULL COMMENT 'storage / phone / desktop；门户内部流水为 NULL',
        \`detail\`            JSON            NULL COMMENT '账单明细，产品传入时原样入',
        \`created_at\`        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_txn_bill_no\` (\`bill_no\`),
        KEY \`idx_txn_user_created\` (\`user_id\`, \`created_at\`),
        KEY \`idx_txn_refund_of\` (\`refund_of_bill_no\`),
        CONSTRAINT \`fk_txn_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`u_user\` (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='资金流水（对账唯一依据，只增不改）';
    `);

    // ---------- w_recharge_apply ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`w_recharge_apply\` (
        \`id\`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`user_id\`       CHAR(36)        NOT NULL,
        \`amount_cents\`  BIGINT          NOT NULL COMMENT '100 ~ 10000000（分）',
        \`remark\`        VARCHAR(255)    NULL COMMENT '转账备注 / 凭证说明',
        \`status\`        SMALLINT        NOT NULL DEFAULT 0 COMMENT '0 待核销 1 已到账 2 驳回',
        \`reviewed_by\`   CHAR(36)        NULL COMMENT '核销管理员 user_id',
        \`reviewed_at\`   DATETIME(3)     NULL,
        \`reject_reason\` VARCHAR(255)    NULL,
        \`created_at\`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        KEY \`idx_recharge_status_created\` (\`status\`, \`created_at\`),
        KEY \`idx_recharge_user\` (\`user_id\`),
        CONSTRAINT \`fk_recharge_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`u_user\` (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='充值申请（人工核销）';
    `);

    // ---------- p_product ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`p_product\` (
        \`id\`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`product_code\` VARCHAR(32)     NOT NULL COMMENT 'storage / phone / desktop',
        \`sku_id\`       VARCHAR(64)     NOT NULL COMMENT '产品内唯一',
        \`name\`         VARCHAR(128)    NOT NULL COMMENT '门户展示名',
        \`spec\`         JSON            NULL COMMENT '规格结构由产品自定',
        \`price_cents\`  INT             NOT NULL COMMENT '单价，单位：分',
        \`billing_mode\` TINYINT         NOT NULL DEFAULT 1 COMMENT '1 包周期 2 按量',
        \`period_days\`  INT             NULL COMMENT 'billing_mode=1 必填',
        \`stock\`        INT             NULL COMMENT 'NULL = 不限或未上报',
        \`is_active\`    TINYINT         NOT NULL DEFAULT 1 COMMENT '1 在售 0 已下架（软下架）',
        \`synced_at\`    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updated_at\`   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_product_code_sku\` (\`product_code\`, \`sku_id\`),
        KEY \`idx_product_active\` (\`product_code\`, \`is_active\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品目录缓存（源在产品，10 分钟全量 upsert）';
    `);

    // ---------- p_product_sync_log ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`p_product_sync_log\` (
        \`id\`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`product_code\`      VARCHAR(32)     NOT NULL,
        \`started_at\`        DATETIME(3)     NOT NULL,
        \`finished_at\`       DATETIME(3)     NULL,
        \`fetched_count\`     INT             NOT NULL DEFAULT 0,
        \`upserted_count\`    INT             NOT NULL DEFAULT 0,
        \`deactivated_count\` INT             NOT NULL DEFAULT 0,
        \`status\`            TINYINT         NOT NULL DEFAULT 0 COMMENT '0 成功 1 失败',
        \`error_msg\`         VARCHAR(512)    NULL,
        \`created_at\`        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        KEY \`idx_sync_product_started\` (\`product_code\`, \`started_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='商品目录同步日志';
    `);

    // ---------- o_order ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`o_order\` (
        \`id\`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`order_no\`    VARCHAR(40)     NOT NULL COMMENT '如 O20260930-000123',
        \`user_id\`     CHAR(36)        NOT NULL,
        \`total_cents\` BIGINT          NOT NULL COMMENT '订单总额，单位：分（后端重算）',
        \`status\`      SMALLINT        NOT NULL DEFAULT 0 COMMENT '0 待支付 1 部分成功 2 全部成功 3 全部失败',
        \`created_at\`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`paid_at\`     DATETIME(3)     NULL,
        \`updated_at\`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_order_no\` (\`order_no\`),
        KEY \`idx_order_user_created\` (\`user_id\`, \`created_at\`),
        CONSTRAINT \`fk_order_user\` FOREIGN KEY (\`user_id\`) REFERENCES \`u_user\` (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单';
    `);

    // ---------- o_order_item ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`o_order_item\` (
        \`id\`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '即契约 order_item_id（provision 幂等键）',
        \`order_id\`    BIGINT UNSIGNED NOT NULL,
        \`user_id\`     CHAR(36)        NOT NULL COMMENT '冗余，便于按用户查询',
        \`product_code\` VARCHAR(32)    NOT NULL,
        \`sku_id\`      VARCHAR(64)     NOT NULL,
        \`quantity\`    INT             NOT NULL DEFAULT 1 COMMENT '云手机单笔限 3',
        \`price_cents\` BIGINT          NOT NULL COMMENT '下单时快照价，单位：分',
        \`status\`      SMALLINT        NOT NULL DEFAULT 0 COMMENT '0 待支付 1 已支付 2 开通成功 3 失败待退款 4 已退款',
        \`instance_id\` VARCHAR(64)     NULL COMMENT '产品 provision 返回的实例 id',
        \`expire_at\`   DATETIME(3)     NULL COMMENT '产品 provision 返回的到期时间',
        \`fail_reason\` VARCHAR(64)     NULL COMMENT '如 OUT_OF_STOCK / INSUFFICIENT_BALANCE',
        \`created_at\`  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        KEY \`idx_item_order\` (\`order_id\`),
        KEY \`idx_item_user_created\` (\`user_id\`, \`created_at\`),
        CONSTRAINT \`fk_item_order\` FOREIGN KEY (\`order_id\`) REFERENCES \`o_order\` (\`id\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单项';
    `);

    // ---------- r_reconciliation ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`r_reconciliation\` (
        \`id\`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`biz_date\`              DATE            NOT NULL COMMENT '对账业务日',
        \`product_code\`          VARCHAR(32)     NOT NULL,
        \`portal_amount_cents\`   BIGINT          NOT NULL DEFAULT 0 COMMENT '门户侧当日金额合计（分）',
        \`product_amount_cents\`  BIGINT          NOT NULL DEFAULT 0 COMMENT '产品侧当日金额合计（分）',
        \`diff_cents\`            BIGINT          NOT NULL DEFAULT 0 COMMENT '差异金额（分）',
        \`diff_count\`            INT             NOT NULL DEFAULT 0 COMMENT '差异笔数',
        \`detail\`                JSON            NULL COMMENT '差异明细',
        \`created_at\`            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_recon_date_product\` (\`biz_date\`, \`product_code\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='日对账结果（产品账单 vs 门户流水）';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 反向删除：先删有外键引用的表
    await queryRunner.query('DROP TABLE IF EXISTS `r_reconciliation`');
    await queryRunner.query('DROP TABLE IF EXISTS `o_order_item`');
    await queryRunner.query('DROP TABLE IF EXISTS `o_order`');
    await queryRunner.query('DROP TABLE IF EXISTS `p_product_sync_log`');
    await queryRunner.query('DROP TABLE IF EXISTS `p_product`');
    await queryRunner.query('DROP TABLE IF EXISTS `w_recharge_apply`');
    await queryRunner.query('DROP TABLE IF EXISTS `w_transaction`');
    await queryRunner.query('DROP TABLE IF EXISTS `w_wallet`');
    await queryRunner.query('DROP TABLE IF EXISTS `u_user`');
  }
}
