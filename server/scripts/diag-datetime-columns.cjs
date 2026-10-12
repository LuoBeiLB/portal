/**
 * 查所有 datetime 列的**库侧默认值**，用来判定"这一列由谁写、用什么口径写"。
 *
 * 结论模型：
 *   - 有 `DEFAULT CURRENT_TIMESTAMP(3)` 且 INSERT 没给值 → **MySQL 生成，本地墙面时间**
 *   - 没有库侧默认值（或应用显式给值）→ **应用写入，TypeORM 序列化为 UTC 墙面时间**
 *
 * 用法：node scripts/diag-datetime-columns.cjs
 */
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
if (existsSync(resolve(process.cwd(), '.env'))) process.loadEnvFile(resolve(process.cwd(), '.env'));

const mysql = require('mysql2/promise');

const QUERY = `
  SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_DEFAULT AS d, EXTRA AS e
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND DATA_TYPE IN ('datetime', 'timestamp')
   ORDER BY TABLE_NAME, COLUMN_NAME`;

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_DATABASE || 'cloud_portal',
    dateStrings: true,
  });

  const [rows] = await conn.query(QUERY);
  console.log(`共 ${rows.length} 个时间列\n`);

  const byClass = { db: [], app: [] };
  for (const row of rows) {
    const hasDefault = row.d !== null;
    (hasDefault ? byClass.db : byClass.app).push(row);
  }

  const pad = (value, width) => String(value ?? '').padEnd(width);

  console.log('=== A 类：有库侧默认值 → MySQL 生成 → **本地墙面时间** ===');
  console.log(`  ${pad('表', 30)}${pad('列', 16)}${pad('默认值', 24)}EXTRA`);
  for (const row of byClass.db) {
    console.log(`  ${pad(row.t, 30)}${pad(row.c, 16)}${pad(row.d, 24)}${row.e ?? ''}`);
  }

  console.log('\n=== B 类：无库侧默认值 → 应用写入 → **UTC 墙面时间** ===');
  console.log(`  ${pad('表', 30)}${pad('列', 16)}${pad('默认值', 24)}EXTRA`);
  for (const row of byClass.app) {
    console.log(`  ${pad(row.t, 30)}${pad(row.c, 16)}${pad(row.d ?? '(无)', 24)}${row.e ?? ''}`);
  }

  console.log(`\n小结：A 类 ${byClass.db.length} 列（本地口径），B 类 ${byClass.app.length} 列（UTC 口径）`);
  console.log('同一个时刻写进这两类列，字符串会差 8 小时 —— 这就是"同一行里差 8 小时"的来源。');

  await conn.end();
})().catch((error) => {
  console.error('失败：', error.message);
  process.exit(1);
});
