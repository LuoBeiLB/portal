import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { loadConfig } from '../config/configuration';
import { buildMysqlOptions, loadEnvFileIfPresent } from '../config/database.options';
import { PORTAL_ENTITIES } from './entities';

// CLI 执行迁移时同样需要 .env
loadEnvFileIfPresent();

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
  ...buildMysqlOptions(config.database, config.database.poolSize),
  synchronize: false,
  logging: config.database.logging,
  entities: PORTAL_ENTITIES,
  migrations: ['src/database/migrations/*.ts'],
  migrationsTableName: 'typeorm_migrations',
});
