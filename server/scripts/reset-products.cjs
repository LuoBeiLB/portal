/**
 * 清空商品缓存与同步日志（端到端自验前置）。
 * 不动用户、钱包、订单数据 —— 只重置商品目录，让同步任务重新跑一遍。
 *
 * 用法：node scripts/reset-products.cjs
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
  await conn.query('DELETE FROM p_product_sync_log');
  await conn.query('DELETE FROM p_product');
  const [rows] = await conn.query('SELECT COUNT(*) AS n FROM p_product');
  console.log(`  · 已清空 p_product / p_product_sync_log（当前商品 ${rows[0].n} 条）`);
  await conn.end();
})().catch((error) => {
  console.error('  · 重置失败:', error.message);
  process.exit(1);
});
