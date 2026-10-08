/**
 * 统一配置装载。
 *
 * 约定：
 * - 金额一律整数「分」；时间一律 ISO 8601 UTC（展示层再转本地时区）。
 * - 密钥类配置只从环境变量或密钥文件读取，**禁止写进仓库**。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type NodeEnv = 'development' | 'test' | 'production';

export interface JwtKeyPair {
  /** JWT header 的 kid，轮换密钥时变更；产品侧 kid 不匹配须立即强刷 JWKS */
  kid: string;
  privateKey: string;
  publicKey: string;
}

export interface ProductEndpoint {
  /** storage / phone / desktop */
  code: string;
  /** 产品后端内网地址，如 http://192.168.99.100:8080 */
  baseUrl: string;
  /** 产品侧调用门户时要带的静态密钥（每产品一码），仅内网可用 */
  internalKey: string;
  /**
   * 是否参与同步与开通。
   * 一期只接云存储，phone / desktop 还没实现，地址留空 → `enabled = false`，
   * 不参与商品同步（否则每轮都刷 `ECONNREFUSED` 噪音日志）。
   * 二期接入时把 URL 与密钥填上即自动启用。
   */
  enabled: boolean;
}

export interface AppConfig {
  env: NodeEnv;
  port: number;
  /** 对外域名（用于生成回调/日志），契约里为 <公网IP> 占位 */
  publicBaseUrl: string;
  swaggerEnabled: boolean;
}

export interface DatabaseConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  charset: string;
  logging: boolean;
  /** 连接池上限；契约的支付流程会串行占用连接，注意与 MySQL max_connections 匹配 */
  poolSize: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
}

export interface JwtConfig {
  /** 当前签发用密钥（含 kid） */
  current: JwtKeyPair;
  /** 历史公钥：轮换后仍需可验签旧 token，映射 kid -> publicKey */
  previous: Array<{ kid: string; publicKey: string }>;
  issuer: string;
  /** access token 有效期（秒），契约 1.2 为 7200 */
  accessTtlSeconds: number;
  /** refresh token 有效期（秒），契约 1.2 为 1209600（14 天） */
  refreshTtlSeconds: number;
}

export interface SecurityConfig {
  /** 一期管理端静态密钥（契约 §6 允许用 X-Admin-Key） */
  adminKey: string;
  /** 登录/注册限流：窗口秒数与窗口内最大次数 */
  authRateLimit: { windowSeconds: number; max: number };
  /** 密码哈希参数（argon2id） */
  argon2: { memoryCost: number; timeCost: number; parallelism: number };
}

export interface ShopConfig {
  /** 商品目录同步间隔（毫秒），契约要求 10 分钟级 */
  productSyncIntervalMs: number;
  /** 单订单最多项数 / 单项最大数量 / 云手机单笔上限 */
  maxItemsPerOrder: number;
  maxQuantityPerItem: number;
  phoneMaxQuantity: number;
  /** 调产品 provision 的超时（毫秒），契约规定 30s */
  provisionTimeoutMs: number;
  /** 调产品商品目录的超时（毫秒） */
  productTimeoutMs: number;
  /**
   * 开通任务的单轮处理上限（条）。
   * 契约里 provision 单次超时 30s，处理是串行的，所以最坏耗时 ≈ 上限 × 30s。
   */
  provisionBatchSize: number;
  /** 开通任务失败后的最大尝试次数（含首次）；用尽后置为 failed，人工/对账介入 */
  provisionMaxAttempts: number;
  /** 认领中的任务超过该毫秒数视为「卡死」，可被重新认领（进程中途被杀的保护） */
  provisionStaleMs: number;
}

export interface WalletConfig {
  rechargeMinCents: number;
  rechargeMaxCents: number;
  /** 扣费/退款重试退避（毫秒），契约 §4.1 建议 1s/5s/30s */
  retryBackoffMs: number[];
}

export interface PortalConfig {
  app: AppConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  jwt: JwtConfig;
  security: SecurityConfig;
  shop: ShopConfig;
  wallet: WalletConfig;
  products: ProductEndpoint[];
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  const parsed = value
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item));
  return parsed.length > 0 ? parsed : fallback;
}

/**
 * 读取 RSA 密钥。
 * 优先取 *_FILE（挂载的 PEM 文件，生产推荐）；否则取内联 PEM（换行可用 \n 表示）。
 */
function loadPem(fileEnv: string | undefined, inlineEnv: string | undefined, label: string): string {
  if (fileEnv) {
    const path = resolve(fileEnv);
    return readFileSync(path, 'utf8');
  }
  if (inlineEnv) {
    return inlineEnv.replace(/\\n/g, '\n');
  }
  // 开发环境允许缺失：签发/验签会在调用时报明确错误，避免服务起不来
  return '';
}

function loadProducts(): ProductEndpoint[] {
  const defaults: Array<{ code: string; envBase: string; envKey: string; fallbackBase: string }> = [
    {
      code: 'storage',
      envBase: 'PRODUCT_STORAGE_BASE_URL',
      envKey: 'PRODUCT_STORAGE_INTERNAL_KEY',
      fallbackBase: 'http://127.0.0.1:8080',
    },
    {
      code: 'phone',
      envBase: 'PRODUCT_PHONE_BASE_URL',
      envKey: 'PRODUCT_PHONE_INTERNAL_KEY',
      fallbackBase: '',
    },
    {
      code: 'desktop',
      envBase: 'PRODUCT_DESKTOP_BASE_URL',
      envKey: 'PRODUCT_DESKTOP_INTERNAL_KEY',
      fallbackBase: '',
    },
    // 下面两项不在契约的产品列表里，仅用于配置规则的单测
    // （需要在 .env 里配地址才会启用，生产永远不会出现）
    { code: 'testa', envBase: 'PRODUCT_TESTA_BASE_URL', envKey: 'PRODUCT_TESTA_INTERNAL_KEY', fallbackBase: '' },
    { code: 'testb', envBase: 'PRODUCT_TESTB_BASE_URL', envKey: 'PRODUCT_TESTB_INTERNAL_KEY', fallbackBase: '' },
  ];

  return defaults
    .map((item) => {
      const baseUrl = (process.env[item.envBase] ?? '').trim().replace(/\/+$/, '');
      const internalKey = process.env[item.envKey] ?? '';
      return {
        code: item.code,
        baseUrl,
        internalKey,
        // 地址留空即视为「未接入」：不参与同步，也不在日志里刷连接错误
        enabled: baseUrl.length > 0,
      };
    })
    .filter((item) => item.enabled);
}

export function loadConfig(): PortalConfig {
  const env = (process.env.NODE_ENV ?? 'development') as NodeEnv;
  const isProd = env === 'production';

  const previousKeys: Array<{ kid: string; publicKey: string }> = [];
  // 轮换期历史公钥：JWT_PREVIOUS_1_KID / JWT_PREVIOUS_1_PUBLIC_KEY(_FILE)
  for (let index = 1; index <= 3; index += 1) {
    const kid = process.env[`JWT_PREVIOUS_${index}_KID`];
    const pem = loadPem(
      process.env[`JWT_PREVIOUS_${index}_PUBLIC_KEY_FILE`],
      process.env[`JWT_PREVIOUS_${index}_PUBLIC_KEY`],
      `previous-${index}`,
    );
    if (kid && pem) previousKeys.push({ kid, publicKey: pem });
  }

  return {
    app: {
      env,
      port: int(process.env.APP_PORT, 3000),
      publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1',
      swaggerEnabled: bool(process.env.SWAGGER_ENABLED, !isProd),
    },
    database: {
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: int(process.env.DB_PORT, 3306),
      username: process.env.DB_USERNAME ?? 'portal',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_DATABASE ?? 'cloud_portal',
      charset: process.env.DB_CHARSET ?? 'utf8mb4',
      logging: bool(process.env.DB_LOGGING, false),
      poolSize: int(process.env.DB_POOL_SIZE, 10),
    },
    redis: {
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: int(process.env.REDIS_PORT, 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      db: int(process.env.REDIS_DB, 0),
      keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'portal:',
    },
    jwt: {
      current: {
        kid: process.env.JWT_KID ?? 'portal-2026-10',
        privateKey: loadPem(process.env.JWT_PRIVATE_KEY_FILE, process.env.JWT_PRIVATE_KEY, 'private'),
        publicKey: loadPem(process.env.JWT_PUBLIC_KEY_FILE, process.env.JWT_PUBLIC_KEY, 'public'),
      },
      previous: previousKeys,
      issuer: process.env.JWT_ISSUER ?? 'cloud-portal',
      accessTtlSeconds: int(process.env.JWT_ACCESS_TTL, 7200),
      refreshTtlSeconds: int(process.env.JWT_REFRESH_TTL, 1209600),
    },
    security: {
      adminKey: process.env.ADMIN_KEY ?? '',
      authRateLimit: {
        windowSeconds: int(process.env.AUTH_RATE_WINDOW, 60),
        max: int(process.env.AUTH_RATE_MAX, 10),
      },
      argon2: {
        memoryCost: int(process.env.ARGON2_MEMORY_COST, 19456),
        timeCost: int(process.env.ARGON2_TIME_COST, 2),
        parallelism: int(process.env.ARGON2_PARALLELISM, 1),
      },
    },
    shop: {
      productSyncIntervalMs: int(process.env.PRODUCT_SYNC_INTERVAL_MS, 10 * 60 * 1000),
      maxItemsPerOrder: int(process.env.MAX_ITEMS_PER_ORDER, 10),
      maxQuantityPerItem: int(process.env.MAX_QUANTITY_PER_ITEM, 10),
      phoneMaxQuantity: int(process.env.PHONE_MAX_QUANTITY, 3),
      provisionTimeoutMs: int(process.env.PROVISION_TIMEOUT_MS, 30_000),
      productTimeoutMs: int(process.env.PRODUCT_TIMEOUT_MS, 10_000),
      provisionBatchSize: int(process.env.PROVISION_BATCH_SIZE, 20),
      provisionMaxAttempts: int(process.env.PROVISION_MAX_ATTEMPTS, 3),
      provisionStaleMs: int(process.env.PROVISION_STALE_MS, 5 * 60 * 1000),
    },
    wallet: {
      rechargeMinCents: int(process.env.RECHARGE_MIN_CENTS, 100),
      rechargeMaxCents: int(process.env.RECHARGE_MAX_CENTS, 10_000_000),
      retryBackoffMs: list(process.env.WALLET_RETRY_BACKOFF_MS, [1000, 5000, 30000]),
    },
    products: loadProducts(),
  };
}

export const CONFIG_TOKEN = 'PORTAL_CONFIG';
