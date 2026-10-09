import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import Redis from 'ioredis';

/**
 * 数据库 / Redis 连接配置的统一构造（运行期与迁移 CLI 共用，保证两边行为一致）。
 *
 * ## ⚠️ 已知问题：时间字段存在 8 小时偏移（未修，需专门处理）
 *
 * MySQL 的 `DATETIME` 不带时区，只是"墙上时间"字符串；mysql2 在序列化 JS `Date` 时
 * **按进程本地时区**格式化（本机 +08:00），而应用读出来时按 UTC 解释。实测：
 *
 * ```
 * 真实 UTC 时刻        : 2026-10-09T01:56:29Z
 * 库里的字符串         : 2026-10-09 09:56:29      ← 本地时间
 * 接口返回             : 2026-10-09T09:56:29Z     ← 把本地时间当 UTC
 * 前端转本地时区展示    : 2026/10/9 17:56:29       ← 整体 +8 小时 ❌
 * ```
 *
 * 已试过且**均无效**的修法（记录在此避免重复踩）：
 * 1. TypeORM 顶层 `timezone: 'Z'` —— 不影响写入序列化；
 * 2. `extra.timezone: 'Z'` —— 同上；
 * 3. `extra.afterConnect` 下发 `SET time_zone` —— mysql2 对 Connection 不认该配置项
 *    （打印 "Ignoring invalid configuration option passed to Connection: afterConnect"）；
 * 4. `extra.init_command` —— 同样被忽略；
 * 5. 仅把 `CreateDateColumn` 换成显式 `@Column` + `ValueTransformer` ——
 *    因为 `manager.insert()` 不触发实体钩子，反而写出 NULL。
 *
 * **下一步应该怎么做**（建议）：不要继续在驱动配置上试错，改为
 * 在服务层统一用「格式化后的 UTC 字符串」写入、读取时显式按 UTC 解析，
 * 并用一条端到端的时区断言（见 `scripts/probe-timezone.cjs`）锁住行为。
 * 在修好之前，前端**不要依据时间字段做任何强逻辑判断**。
 *
 * 当前配置保持与已验证版本一致，不引入上述任何无效选项。
 */
export const DB_TIMEZONE = 'Z' as const;

export interface RawDbConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  charset: string;
}

/** TypeORM 连接参数（运行期与 CLI 共用） */
export function buildMysqlOptions(db: RawDbConfig, poolSize: number) {
  return {
    type: 'mysql' as const,
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password,
    database: db.database,
    charset: db.charset,
    timezone: DB_TIMEZONE,
    supportBigNumbers: true,
    bigNumberStrings: true,
    extra: {
      connectionLimit: poolSize,
      charset: db.charset,
    },
  };
}

/** Redis 客户端（懒连接，便于迁移脚本等不依赖 Redis 的场景复用） */
export function buildRedisClient(options: {
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
}): Redis {
  return new Redis({
    host: options.host,
    port: options.port,
    password: options.password,
    db: options.db,
    keyPrefix: options.keyPrefix,
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 3000,
    retryStrategy: (times: number) => Math.min(times * 500, 10_000),
  });
}

/** 读入 .env（Node 20+ 原生，免 dotenv 依赖）；CLI 脚本与 main.ts 共用 */
export function loadEnvFileIfPresent(): void {
  const envFile = resolve(process.cwd(), '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}
