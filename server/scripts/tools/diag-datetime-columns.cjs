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

  console.log(`\n小结：库生成列 ${byClass.db.length} 个，应用写列 ${byClass.app.length} 个`);
  console.log('');
  console.log('【口径说明】（2026-10-12 统一后）');
  console.log('  · 两类列在库里的**字面量**确实不同（库生成=本地墙面 / 应用写=UTC 墙面），');
  console.log('    但**读写偏移正好互相抵消**，所以对外输出的都是「墙上时间」。');
  console.log('  · 前端规则：接口返回的时间字符串**直接展示，不要做时区转换**。');
  console.log('  · 本清单的用途是复核：');
  console.log('      - 新加的时间列该归哪一类（业务时刻 → 应用写；审计/创建时间 → 库生成）');
  console.log('      - 别把 @CreateDateColumn / @UpdateDateColumn 又写回来（它们会让 TypeORM 自己写值，');
  console.log('        与库生成列混在一行里就会差 8 小时 —— 这是当初那个 bug 的根源）');
  console.log('  · 回归防护：scripts/e2e/e2e-admin.cjs 第 11 段有 4 条时间口径断言。');

  await conn.end();
})().catch((error) => {
  console.error('失败：', error.message);
  process.exit(1);
});
