import { loadConfig } from './configuration';

const KEYS = [
  'NODE_ENV',
  'APP_PORT',
  'DB_HOST',
  'DB_PORT',
  'DB_POOL_SIZE',
  'REDIS_HOST',
  'REDIS_PORT',
  'JWT_KID',
  'JWT_ISSUER',
  'JWT_ACCESS_TTL',
  'JWT_REFRESH_TTL',
  'PRODUCT_SYNC_INTERVAL_MS',
  'PROVISION_TIMEOUT_MS',
  'PHONE_MAX_QUANTITY',
  'RECHARGE_MIN_CENTS',
  'RECHARGE_MAX_CENTS',
  'WALLET_RETRY_BACKOFF_MS',
  'PRODUCT_STORAGE_BASE_URL',
  'PRODUCT_STORAGE_INTERNAL_KEY',
] as const;

describe('loadConfig（契约 §0.1 / §1.2 / §2.2 / §3.3 / §4.1 / §5）', () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    KEYS.forEach((key) => {
      saved[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterAll(() => {
    KEYS.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  });

  it('缺省值与契约一致：端口 3000 / access 2h / refresh 14d / provision 30s', () => {
    const config = loadConfig();
    expect(config.app.port).toBe(3000);
    expect(config.jwt.issuer).toBe('cloud-portal');
    expect(config.jwt.accessTtlSeconds).toBe(7200);
    expect(config.jwt.refreshTtlSeconds).toBe(1209600);
    expect(config.shop.provisionTimeoutMs).toBe(30_000);
    // 契约 §5.1：商品目录 10 分钟级同步
    expect(config.shop.productSyncIntervalMs).toBe(600_000);
    // 契约 §2.2：单订单 1~10 项；云手机限 3
    expect(config.shop.maxItemsPerOrder).toBe(10);
    expect(config.shop.phoneMaxQuantity).toBe(3);
    // 契约 §3.3：充值金额 100 ~ 10,000,000 分
    expect(config.wallet.rechargeMinCents).toBe(100);
    expect(config.wallet.rechargeMaxCents).toBe(10_000_000);
    // 契约 §4.1：退避 1s/5s/30s
    expect(config.wallet.retryBackoffMs).toEqual([1000, 5000, 30000]);
  });

  it('产品列表默认含 storage / phone / desktop 三个 code', () => {
    const codes = loadConfig().products.map((item) => item.code);
    expect(codes).toEqual(['storage', 'phone', 'desktop']);
  });

  it('环境变量覆盖生效，且 baseUrl 末尾斜杠被规范化', () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_PORT = '3100';
    process.env.PRODUCT_STORAGE_BASE_URL = 'http://192.168.99.100:8080///';
    process.env.PRODUCT_STORAGE_INTERNAL_KEY = 'k-storage';
    process.env.WALLET_RETRY_BACKOFF_MS = '2000, 6000';

    const config = loadConfig();
    expect(config.app.env).toBe('production');
    expect(config.app.port).toBe(3100);
    const storage = config.products.find((item) => item.code === 'storage');
    expect(storage?.baseUrl).toBe('http://192.168.99.100:8080');
    expect(storage?.internalKey).toBe('k-storage');
    expect(config.wallet.retryBackoffMs).toEqual([2000, 6000]);

    delete process.env.NODE_ENV;
    delete process.env.APP_PORT;
    delete process.env.PRODUCT_STORAGE_BASE_URL;
    delete process.env.PRODUCT_STORAGE_INTERNAL_KEY;
    delete process.env.WALLET_RETRY_BACKOFF_MS;
  });

  it('生产环境默认关闭 swagger；非法数字回退到默认值', () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_PORT = 'not-a-number';
    process.env.DB_PORT = 'abc';

    const config = loadConfig();
    expect(config.app.swaggerEnabled).toBe(false);
    expect(config.app.port).toBe(3000);
    expect(config.database.port).toBe(3306);

    delete process.env.NODE_ENV;
    delete process.env.APP_PORT;
    delete process.env.DB_PORT;
  });

  it('未配置密钥时不抛异常（留给调用期报错，避免服务起不来）', () => {
    const config = loadConfig();
    expect(config.jwt.current.privateKey).toBe('');
    expect(config.jwt.current.publicKey).toBe('');
    expect(config.jwt.previous).toEqual([]);
  });
});
