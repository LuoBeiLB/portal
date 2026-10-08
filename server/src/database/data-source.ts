import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { DataSource } from 'typeorm';

import { loadConfig } from '../config/configuration';
import { PORTAL_ENTITIES } from './entities';

// CLI 执行迁移时同样需要 .env
const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/**
 * TypeORM CLI / 迁移专用 DataSource。
 *
 * 用法（迁移纪律：开发统一走 migration:run，不使用 synchronize）：
 *   npm run migration:run
 *   npm run migration:show
 *   npm run migration:revert
 *
 * 注意：迁移文件用 .ts 编写，由 typeorm-ts-node-commonjs 加载；生产构建后
 * 若需用 dist 执行，请改用 `-d dist/database/data-source.js`。
 */
const config = loadConfig();

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: config.database.host,
  port: config.database.port,
  username: config.database.username,
  password: config.database.password,
  database: config.database.database,
  charset: config.database.charset,
  // 时区统一按 UTC 存取，展示层再转本地（契约 §0.4）
  timezone: 'Z',
  supportBigNumbers: true,
  bigNumberStrings: true,
  synchronize: false,
  logging: config.database.logging,
  entities: PORTAL_ENTITIES,
  migrations: ['src/database/migrations/*.ts'],
  migrationsTableName: 'typeorm_migrations',
});
