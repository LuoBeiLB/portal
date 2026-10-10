/**
 * 查 u_user 表结构（只读诊断）。
 * 用法：node scripts/check-user-table.cjs
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_DATABASE || 'cloud_portal',
  });
  const db = process.env.DB_DATABASE || 'cloud_portal';

  const [cols] = await conn.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'u_user'
      ORDER BY ORDINAL_POSITION`,
    [db],
  );
  console.log('--- u_user 列 ---');
  for (const r of cols) {
    console.log(
      `  ${String(r.COLUMN_NAME).padEnd(16)}${String(r.COLUMN_TYPE).padEnd(16)}` +
        `null=${r.IS_NULLABLE}  default=${String(r.COLUMN_DEFAULT)}  ${r.COLUMN_COMMENT ?? ''}`,
    );
  }

  const hasRole = cols.some((c) => c.COLUMN_NAME === 'role');
  console.log(`\n  role 列存在: ${hasRole ? '是' : '**否**'}`);

  const [count] = await conn.query('SELECT COUNT(*) AS n FROM u_user');
  console.log(`  用户数: ${count[0].n}`);

  await conn.end();
})().catch((error) => {
  console.error('失败:', error.message);
  process.exit(1);
});
