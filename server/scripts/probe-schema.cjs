/**
 * 核对已建表的实际字符集/排序规则与迁移记录，判断是否存在「MySQL 5.7 忽略 8.0 排序规则」的隐患。
 */
const mysql = require('mysql2/promise');

(async () => {
  const db = process.env.DB_DATABASE || 'cloud_portal';
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: db,
  });

  const [tables] = await conn.query(
    'SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS coll FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [db],
  );
  console.log('--- 表字符集/排序规则 ---');
  for (const row of tables) {
    console.log(`  ${row.name.padEnd(20)} engine=${row.engine} collation=${row.coll}`);
  }

  const [migrations] = await conn.query('SELECT * FROM typeorm_migrations ORDER BY id');
  console.log('--- 迁移记录 ---');
  for (const row of migrations) {
    console.log(`  id=${row.id} ts=${row.timestamp} name=${row.name}`);
  }

  const [order] = await conn.query('SHOW CREATE TABLE o_order');
  console.log('--- o_order 建表语句尾部 ---');
  const ddl = Object.values(order[0])[1];
  console.log(' ', ddl.split('\n').slice(-3).join('\n  '));

  await conn.end();
})().catch((error) => {
  console.error('失败:', error.code, error.message);
  process.exit(1);
});
