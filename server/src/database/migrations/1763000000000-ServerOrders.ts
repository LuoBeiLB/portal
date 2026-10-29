import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 服务端下单（产品 → 门户）需要的幂等键。
 *
 * `o_order` 原本只有内部 `order_no`，产品重试一次就会多一个订单、多扣一次钱。
 * 加一列 `client_order_key`（产品侧单号）+ 唯一索引兜底：
 * 同一个 key 重复提交时由**数据库**保证不会产生第二个订单（应用层再返回首次结果）。
 *
 * 用户自助下单没有这个 key，值为 NULL；MySQL 的唯一索引允许多个 NULL，不影响存量数据。
 */
export class ServerOrders1763000000000 implements MigrationInterface {
  name = 'ServerOrders1763000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`o_order\`
         ADD COLUMN \`client_order_key\` VARCHAR(64) NULL
           COMMENT '产品侧单号（服务端下单幂等键）；用户自助下单为 NULL' AFTER \`user_id\``,
    );
    await queryRunner.query(
      'ALTER TABLE `o_order` ADD UNIQUE KEY `uk_client_order` (`client_order_key`)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `o_order` DROP INDEX `uk_client_order`');
    await queryRunner.query('ALTER TABLE `o_order` DROP COLUMN `client_order_key`');
  }
}
