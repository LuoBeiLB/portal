import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 第 3 轮：商城与开通。
 *
 * 新增：
 * - `o_provision_job` 开通任务队列（支付与开通解耦，避免在 HTTP 里等 30s）
 * - `r_product_bill_report` 产品账单上报（对账的数据来源，门户不直连产品库）
 * 补充：
 * - `o_order.paying_at`：进入开通阶段的时刻（也是「卡在开通中」的判定依据）
 */
export class ShopAndProvision1759700000000 implements MigrationInterface {
  name = 'ShopAndProvision1759700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`o_provision_job\` (
        \`id\`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`order_id\`       BIGINT UNSIGNED NOT NULL,
        \`order_item_id\`  BIGINT UNSIGNED NOT NULL COMMENT '= o_order_item.id，产品 provision 的幂等键',
        \`user_id\`        CHAR(36)        NOT NULL,
        \`product_code\`   VARCHAR(32)     NOT NULL,
        \`status\`         SMALLINT        NOT NULL DEFAULT 0 COMMENT '0 待处理 1 处理中 2 成功 3 失败',
        \`attempts\`       INT             NOT NULL DEFAULT 0,
        \`max_attempts\`   INT             NOT NULL DEFAULT 3,
        \`next_run_at\`    DATETIME(3)     NOT NULL,
        \`claimed_at\`     DATETIME(3)     NULL COMMENT '认领时间，超时视为卡死可重新认领',
        \`last_error\`     VARCHAR(512)    NULL,
        \`created_at\`     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        \`updated_at\`     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_job_order_item\` (\`order_item_id\`),
        KEY \`idx_job_status_next\` (\`status\`, \`next_run_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='开通任务队列';
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS \`r_product_bill_report\` (
        \`id\`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        \`biz_date\`        DATE            NOT NULL COMMENT '账单所属业务日（UTC）',
        \`product_code\`    VARCHAR(32)     NOT NULL,
        \`bill_no\`         VARCHAR(64)     NOT NULL COMMENT '产品侧账单号',
        \`portal_user_id\`  CHAR(36)        NULL,
        \`amount_cents\`    BIGINT          NOT NULL COMMENT '单位：分',
        \`type\`            TINYINT         NOT NULL DEFAULT 2 COMMENT '1 充值 2 扣费 3 退款',
        \`related_bill_no\` VARCHAR(64)     NULL COMMENT '退款时指向的原单',
        \`created_at\`      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_report_date_product_bill\` (\`biz_date\`, \`product_code\`, \`bill_no\`),
        KEY \`idx_report_date_product\` (\`biz_date\`, \`product_code\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='产品账单上报（对账依据）';
    `);

    // o_order 补列：进入开通阶段的时刻
    const hasPayingAt = await queryRunner.hasColumn('o_order', 'paying_at');
    if (!hasPayingAt) {
      await queryRunner.query(
        `ALTER TABLE \`o_order\` ADD COLUMN \`paying_at\` DATETIME(3) NULL COMMENT '进入开通阶段的时刻' AFTER \`paid_at\``,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasPayingAt = await queryRunner.hasColumn('o_order', 'paying_at');
    if (hasPayingAt) {
      await queryRunner.query('ALTER TABLE `o_order` DROP COLUMN `paying_at`');
    }
    await queryRunner.query('DROP TABLE IF EXISTS `r_product_bill_report`');
    await queryRunner.query('DROP TABLE IF EXISTS `o_provision_job`');
  }
}
