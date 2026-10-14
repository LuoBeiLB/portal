import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import Redis from 'ioredis';

/**
 * 数据库 / Redis 连接配置的统一构造（运行期与迁移 CLI 共用，保证两边行为一致）。
 *
 * ## 时间字段口径：**已统一**（2026-10-12，本条替代原先的"已知问题"说明）
 *
 * 曾经的问题：同一个库里有**两类时间列、两种时区约定**，同一行里两个时间列会差 8 小时。
 *
 * | | 库生成列（`created_at` / `updated_at` / `synced_at`） | 应用写列（`paid_at` / `started_at` …） |
 * |---|---|---|
 * | 谁写 | MySQL `DEFAULT CURRENT_TIMESTAMP(3)` | TypeORM |
 * | 库里字面量 | **本地墙面** `10:42` | **UTC 墙面** `02:42` |
 *
 * **根因不在 mysql2**（原注释判断错了）：TypeORM 在把值交给 mysql2 **之前**，
 * 已用 `DateUtils.mixedDateToDate` 拼好字符串，绕过了 mysql2 的 Date 序列化。
 * 决定性证据 —— 抓到 TypeORM 生成的 SQL 是 UTC 字面量：
 *
 * ```
 * INSERT INTO tmp(...) VALUES ('2026-10-12 02:25:20.728')   -- UTC；同一刻本地是 10:25:20
 * 同一张表同一秒：via_insert=02:25:27.604（TypeORM） vs via_db_now=10:25:27.615（库）
 * ```
 *
 * 所以原注释里那 5 条"试过无效"的修法方向都偏了 —— 它们都在调 **mysql2 的时区**，
 * 而决定权在 **TypeORM 这一层**。
 *
 * **实际采用的方案**：全部交给库生成。关键机制是"应用不给值时，TypeORM 生成的 INSERT
 * 就是 `DEFAULT`"（实测）：`INSERT INTO p_product(id, sku_id, created_at) VALUES (DEFAULT, ?, DEFAULT)`。
 *
 * 1. 17 处 `@CreateDateColumn` / `@UpdateDateColumn` → 显式 `@Column` + `default: () => 'CURRENT_TIMESTAMP(3)'`
 *    （前两个装饰器会让 TypeORM **总是自己写值**，是偏移的根源）
 * 2. 去掉应用显式写 `createdAt` / `updatedAt` / `syncedAt` 的地方
 * 3. `next_run_at` / `claimed_at` 这类**参与内部运算**的列**故意保持真实时刻**（不与 `Date.now()` 错位）
 * 4. 展示型的"应用写"字段在**出口**补一次本地偏移（`common/local-time.ts` 的 `instantToWallIso`）
 *
 * **对外表现**：接口返回的时间字符串就是"墙上时间"，**前端直接展示、不要做时区转换**。
 * 详见 `docs/09-契约v1.1差异与补充.md` §2.3。
 *
 * `timezone: 'Z'` 保留：它决定**读取**时把库里的字符串按 UTC 解析，是上面第 4 步的前提。
 * 回归防护见 `scripts/tools/diag-datetime-columns.cjs`（列口径清单）与
 * `scripts/e2e/e2e-admin.cjs` 第 11 段（4 条时间口径断言）。
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
