/**
 * 只读探测本机 MySQL：版本、库、表、支持的 utf8mb4 排序规则。
 * 用途：在跑迁移前确认目标环境能力，避免直接撞 8.0 专属排序规则。
 */
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_DATABASE || 'cloud_portal',
  });

  const [version] = await conn.query('SELECT VERSION() AS v, @@character_set_server AS cs, @@collation_server AS coll, @@sql_mode AS sqlMode, @@time_zone AS tz');
  console.log('服务器:', JSON.stringify(version[0]));

  const [tables] = await conn.query('SHOW TABLES');
  console.log('表数量:', tables.length);
  if (tables.length > 0) {
    console.log('表:', tables.map((row) => Object.values(row)[0]).join(', '));
  }

  const [schema] = await conn.query(
    'SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS coll FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
    [process.env.DB_DATABASE || 'cloud_portal'],
  );
  console.log('库默认:', JSON.stringify(schema[0]));

  const [collations] = await conn.query(
    "SELECT COLLATION_NAME AS name FROM information_schema.COLLATIONS WHERE COLLATION_NAME IN ('utf8mb4_general_ci','utf8mb4_unicode_ci','utf8mb4_0900_ai_ci','utf8mb4_bin')",
  );
  console.log('可用 utf8mb4 排序规则:', collations.map((row) => row.name).join(', '));

  await conn.end();
})().catch((error) => {
  console.error('探测失败:', error.code, error.message);
  process.exit(1);
});
