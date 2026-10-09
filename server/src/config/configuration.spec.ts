/**
 * 配置装载测试。
 *
 * 注意：这些用例**不依赖运行环境**。
 * 原因：应用会在启动时 `process.loadEnvFile('.env')`，而 loadEnvFile 把「空值」视为未设置
 * （不会用空串覆盖已有变量）。若测试直接断言"某产品没配地址"，会被本机 .env 污染。
 * 因此这里用无关的空前缀变量（未在 .env 中出现）来验证规则本身。
 */
process.env.NODE_ENV = 'test';
process.env.JWT_ISSUER = 'cloud-portal';
process.env.JWT_ACCESS_TTL = '';
process.env.JWT_REFRESH_TTL = '';
process.env.PROVISION_TIMEOUT_MS = '';
process.env.PRODUCT_SYNC_INTERVAL_MS = '';
process.env.PHONE_MAX_QUANTITY = '';
process.env.RECHARGE_MIN_CENTS = '';
process.env.RECHARGE_MAX_CENTS = '';
process.env.WALLET_RETRY_BACKOFF_MS = '';
process.env.MAX_ITEMS_PER_ORDER = '';
// 只有这两个变量未在 .env 中出现，可安全用于「未接入 → 被剔除」的断言
process.env.PRODUCT_TESTA_BASE_URL = 'http://127.0.0.1:8111';
process.env.PRODUCT_TESTA_INTERNAL_KEY = 'k-a';
delete process.env.PRODUCT_TESTB_BASE_URL;
delete process.env.PRODUCT_TESTB_INTERNAL_KEY;

import { loadConfig } from './configuration';

describe('loadConfig（契约 §0.1 / §1.2 / §2.2 / §3.3 / §4.1 / §5）', () => {
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

  it('地址非空的产品进列表且 enabled=true（参与同步与开通）', () => {
    const config = loadConfig();
    const testA = config.products.find((item) => item.code === 'testa');
    expect(testA?.enabled).toBe(true);
    expect(testA?.baseUrl).toBe('http://127.0.0.1:8111');
    expect(testA?.internalKey).toBe('k-a');
  });

  it('地址与密钥都没配的产品不进列表（既不参与同步，也做不了入站鉴权）', () => {
    const config = loadConfig();
    expect(config.products.some((item) => item.code === 'testb')).toBe(false);
  });

  it('**只配了密钥、地址为空的产品也进列表**，但标记为仅入站（enabled=false）', () => {
    process.env.PRODUCT_TESTB_INTERNAL_KEY = 'k-b-inbound-only';
    delete process.env.PRODUCT_TESTB_BASE_URL;

    const config = loadConfig();
    const testB = config.products.find((item) => item.code === 'testb');

    // 存在的意义：产品调门户扣费/退款时的 X-Internal-Key 要靠它校验
    expect(testB).toBeDefined();
    expect(testB?.internalKey).toBe('k-b-inbound-only');
    // 但不得参与出站：enabled=false 会被 forSync() 过滤，findByCode() 也会拦
    expect(testB?.enabled).toBe(false);
    expect(testB?.baseUrl).toBe('');

    delete process.env.PRODUCT_TESTB_INTERNAL_KEY;
  });

  it('入站密钥的加载与出站地址解耦：清空地址不会让已配的密钥失效', () => {
    process.env.PRODUCT_TESTA_INTERNAL_KEY = 'k-a-decoupled';
    process.env.PRODUCT_TESTA_BASE_URL = 'http://127.0.0.1:8111';
    const withAddress = loadConfig();
    expect(withAddress.products.find((item) => item.code === 'testa')?.internalKey).toBe('k-a-decoupled');

    // 模拟"暂停该产品的商品同步"——只清地址，保留密钥
    delete process.env.PRODUCT_TESTA_BASE_URL;
    const withoutAddress = loadConfig();
    const testA = withoutAddress.products.find((item) => item.code === 'testa');

    expect(testA?.internalKey).toBe('k-a-decoupled'); // ← 密钥仍在，入站鉴权不受影响
    expect(testA?.enabled).toBe(false); // ← 但不再参与同步

    process.env.PRODUCT_TESTA_BASE_URL = 'http://127.0.0.1:8111';
    process.env.PRODUCT_TESTA_INTERNAL_KEY = 'k-a';
  });

  it('环境变量覆盖生效，且 baseUrl 末尾斜杠被规范化', () => {
    process.env.APP_PORT = '3100';
    process.env.PRODUCT_TESTA_BASE_URL = 'http://192.168.99.100:8080///';
    process.env.WALLET_RETRY_BACKOFF_MS = '2000, 6000';

    const config = loadConfig();
    expect(config.app.port).toBe(3100);
    const testA = config.products.find((item) => item.code === 'testa');
    expect(testA?.baseUrl).toBe('http://192.168.99.100:8080');
    expect(config.wallet.retryBackoffMs).toEqual([2000, 6000]);

    process.env.PRODUCT_TESTA_BASE_URL = 'http://127.0.0.1:8111';
    delete process.env.APP_PORT;
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

    process.env.NODE_ENV = 'test';
    delete process.env.APP_PORT;
    delete process.env.DB_PORT;
  });

  it('未配置密钥时不抛异常（留给调用期报错，避免服务起不来）', () => {
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;
    delete process.env.JWT_PRIVATE_KEY_FILE;
    delete process.env.JWT_PUBLIC_KEY_FILE;

    const config = loadConfig();
    expect(config.jwt.current.privateKey).toBe('');
    expect(config.jwt.current.publicKey).toBe('');
    expect(config.jwt.previous).toEqual([]);
  });
});
