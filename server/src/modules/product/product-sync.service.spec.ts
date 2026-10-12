import { PortalConfigService } from '../../config/portal-config.service';
import { BillingMode, ProductEntity } from './entities/product.entity';
import { ProductSyncLogEntity } from './entities/product-sync-log.entity';
import { ProductSyncService } from './product-sync.service';

interface FakeRepo {
  find: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
  count?: jest.Mock;
}

/** 构造一个只关心 `find` 的 Product 仓储替身（同步路径还需要 save/create/findOne） */
function productsOf(rows: ProductEntity[]): FakeRepo {
  return {
    find: jest.fn().mockResolvedValue(rows),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    create: jest.fn().mockImplementation((data) => data),
    count: jest.fn().mockResolvedValue(rows.length),
  };
}

function serviceOf(
  products: FakeRepo,
  ttlMs: number,
  client: { fetchProducts?: jest.Mock } = {},
  logs: { save?: jest.Mock; find?: jest.Mock } = {},
  syncIntervalMs = 600_000,
): ProductSyncService {
  const config = {
    shop: {
      productListCacheTtlMs: ttlMs,
      productTimeoutMs: 1000,
      provisionTimeoutMs: 1000,
      productSyncIntervalMs: syncIntervalMs,
    },
  } as unknown as PortalConfigService;

  // 2026-10-12：listForShop 现在会额外查 p_product_sync_log 算"目录新鲜度"，
  // 所以 logs 替身必须带 find（默认"无同步记录"）
  const logsRepo = {
    save: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    ...logs,
  };

  const service = new ProductSyncService(
    products as never,
    logsRepo as never,
    (client as never) ?? ({} as never),
    config,
  );
  return service;
}

function row(skuId: string, priceCents: number): ProductEntity {
  return {
    id: '1',
    productCode: 'storage',
    skuId,
    name: skuId,
    spec: null,
    priceCents,
    billingMode: BillingMode.PERIOD,
    periodDays: 30,
    stock: null,
    isActive: 1,
    syncedAt: new Date('2026-10-09T01:00:00Z'),
    updatedAt: new Date('2026-10-09T01:00:00Z'),
  } as ProductEntity;
}

describe('ProductSyncService.listForShop —— 公开接口的缓存行为', () => {
  it('TTL 内重复调用只查一次库（公开接口不能被无限刷库）', async () => {
    const products = productsOf([row('storage-500g', 50000)]);
    const service = serviceOf(products, 10_000);

    const first = await service.listForShop();
    const second = await service.listForShop();

    expect(products.find).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first.list).toHaveLength(1);
    expect(first.list[0].sku_id).toBe('storage-500g');
  });

  it('不同 product_code 各自缓存，互不串味', async () => {
    const products = productsOf([row('storage-500g', 50000)]);
    const service = serviceOf(products, 10_000);

    await service.listForShop('storage');
    await service.listForShop('phone');
    await service.listForShop('storage'); // 命中缓存

    // storage / phone 各查一次，第二次 storage 命中缓存
    expect(products.find).toHaveBeenCalledTimes(2);
  });

  it('TTL 过期后重新查库（保证调价最多延迟 TTL）', async () => {
    const products = productsOf([row('storage-500g', 50000)]);
    const service = serviceOf(products, 1); // 1ms TTL

    await service.listForShop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await service.listForShop();

    expect(products.find).toHaveBeenCalledTimes(2);
  });

  it('TTL=0 时关闭缓存，每次都查库（排障用）', async () => {
    const products = productsOf([row('storage-500g', 50000)]);
    const service = serviceOf(products, 0);

    await service.listForShop();
    await service.listForShop();

    expect(products.find).toHaveBeenCalledTimes(2);
  });

  it('同步成功后缓存被主动失效，调价立刻可见（不必等 TTL）', async () => {
    const products = productsOf([row('storage-500g', 50000)]);
    const client = { fetchProducts: jest.fn().mockResolvedValue([]) };
    const logs = {
      save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
      create: jest.fn().mockImplementation((data) => data),
    };
    // 同一个实例：先靠 listForShop 把缓存填上，再跑一次同步，验证缓存被清
    const service = serviceOf(products, 60_000, client, logs);

    await service.listForShop();
    expect(products.find).toHaveBeenCalledTimes(1);

    await service.syncOne('storage'); // 成功同步 → clearListCache()

    // 注意：syncOne 内部的 upsert() 也会调 find，所以先清计数再断言
    products.find.mockClear();
    await service.listForShop();
    expect(products.find).toHaveBeenCalledTimes(1); // 又重新查库 = 缓存确实失效
  });
});

/**
 * 目录新鲜度（2026-10-12 新增）。
 *
 * 背景：同步失败时门户**保留上一次成功的目录**（宁愿卖旧价也不让商城空掉），
 * 于是会出现"日志一直报同步失败，但商品列表照常返回"的现象 ——
 * 用户和管理端都看不出这些是旧价格。`catalog.stale` 就是给前端的信号。
 */
describe('ProductSyncService.listForShop —— 目录新鲜度（catalog）', () => {
  const freshRow = (skuId: string, syncedAt: Date): ProductEntity =>
    ({ ...row(skuId, 50000), syncedAt }) as ProductEntity;

  it('最近一次同步失败 -> stale=true，并带出失败原因', async () => {
    const products = productsOf([freshRow('storage-500g', new Date())]);
    const logs = {
      find: jest
        .fn()
        .mockResolvedValue([{ id: '9', status: 1, errorMsg: 'timeout of 10000ms exceeded', startedAt: new Date() }]),
    };
    const service = serviceOf(products, 0, {}, logs);

    const result = await service.listForShop();
    expect(result.catalog.stale).toBe(true);
    expect(result.catalog.last_sync_ok).toBe(false);
    expect(result.catalog.last_error).toBe('timeout of 10000ms exceeded');
  });

  it('最近一次同步成功且数据新鲜 -> stale=false，last_error 为 null', async () => {
    const products = productsOf([freshRow('storage-500g', new Date())]);
    const logs = { find: jest.fn().mockResolvedValue([{ id: '9', status: 0, errorMsg: null, startedAt: new Date() }]) };
    const service = serviceOf(products, 0, {}, logs);

    const result = await service.listForShop();
    expect(result.catalog.stale).toBe(false);
    expect(result.catalog.last_sync_ok).toBe(true);
    expect(result.catalog.last_error).toBeNull();
  });

  it('**同步"成功但一直拿到 0 条"也会 stale**（数据超过 3 个周期没更新）', async () => {
    // 数据停留在很久以前，但同步状态是"成功" —— 只靠 status 判断会漏掉这种
    const old = new Date(Date.now() - 60 * 60 * 1000); // 1 小时前
    const products = productsOf([freshRow('storage-500g', old)]);
    const logs = { find: jest.fn().mockResolvedValue([{ id: '9', status: 0, errorMsg: null, startedAt: new Date() }]) };
    const service = serviceOf(products, 0, {}, logs, 600_000); // 3 个周期 = 30 分钟

    const result = await service.listForShop();
    expect(result.catalog.stale).toBe(true);
    expect(result.catalog.last_sync_ok).toBe(true); // 同步本身没报错
    expect(result.catalog.data_synced_at).toBe(old.toISOString()); // 数据停在这里
  });

  it('从未同步过（无日志）-> stale=true 且字段为 null', async () => {
    const products = productsOf([freshRow('storage-500g', new Date())]);
    const service = serviceOf(products, 0, {}, { find: jest.fn().mockResolvedValue([]) });

    const result = await service.listForShop();
    expect(result.catalog.stale).toBe(true);
    expect(result.catalog.last_sync_ok).toBeNull();
    expect(result.catalog.last_sync_at).toBeNull();
  });

  it('商品为空 -> data_synced_at 为 null 且 stale=true', async () => {
    const products = productsOf([]);
    const logs = { find: jest.fn().mockResolvedValue([{ id: '9', status: 0, errorMsg: null, startedAt: new Date() }]) };
    const service = serviceOf(products, 0, {}, logs);

    const result = await service.listForShop();
    expect(result.list).toHaveLength(0);
    expect(result.catalog.data_synced_at).toBeNull();
    expect(result.catalog.stale).toBe(true);
  });
});
