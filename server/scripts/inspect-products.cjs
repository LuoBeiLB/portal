/**
 * 查看商品相关表结构（只读诊断）。
 * 用法：node scripts/inspect-products.cjs
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_DATABASE || 'cloud_portal',
  });
  const db = process.env.DB_DATABASE || 'cloud_portal';

  for (const table of ['p_product', 'p_product_sync_log']) {
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [db, table],
    );
    console.log(`\n--- ${table} ---`);
    for (const row of cols) {
      console.log(
        `  ${String(row.COLUMN_NAME).padEnd(16)}${String(row.COLUMN_TYPE).padEnd(16)}` +
          `${row.IS_NULLABLE === 'YES' ? 'NULL ' : 'NOT  '}${row.COLUMN_COMMENT ?? ''}`,
      );
    }

    const [indexes] = await conn.query(
      `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, NON_UNIQUE
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        GROUP BY INDEX_NAME, NON_UNIQUE`,
      [db, table],
    );
    console.log('  索引:');
    for (const row of indexes) {
      console.log(`    ${String(row.INDEX_NAME).padEnd(24)}${row.NON_UNIQUE === 0 ? '唯一' : '普通'} (${row.cols})`);
    }
  }

  const [count] = await conn.query('SELECT COUNT(*) AS n FROM p_product');
  const [active] = await conn.query('SELECT COUNT(*) AS n FROM p_product WHERE is_active = 1');
  console.log(`\n商品行数: ${count[0].n}（在售 ${active[0].n}）`);

  const [rows] = await conn.query(
    'SELECT product_code, sku_id, name, price_cents, billing_mode, period_days, stock, is_active FROM p_product ORDER BY id',
  );
  console.log('当前商品:');
  for (const row of rows) console.log('   ', JSON.stringify(row));

  await conn.end();
})().catch((error) => {
  console.error('诊断失败:', error.message);
  process.exit(1);
});
