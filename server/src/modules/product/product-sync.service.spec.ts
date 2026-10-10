import { PortalConfigService } from '../../config/portal-config.service';
import { BillingMode, ProductEntity } from './entities/product.entity';
import { ProductSyncLogEntity } from './entities/product-sync-log.entity';
import { ProductSyncService } from './product-sync.service';

interface FakeRepo {
  find: jest.Mock;
  findOne: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
}

/** 构造一个只关心 `find` 的 Product 仓储替身（同步路径还需要 save/create/findOne） */
function productsOf(rows: ProductEntity[]): FakeRepo {
  return {
    find: jest.fn().mockResolvedValue(rows),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
    create: jest.fn().mockImplementation((data) => data),
  };
}

function serviceOf(
  products: FakeRepo,
  ttlMs: number,
  client: { fetchProducts?: jest.Mock } = {},
  logs: { save?: jest.Mock } = {},
): ProductSyncService {
  const config = {
    shop: { productListCacheTtlMs: ttlMs, productTimeoutMs: 1000, provisionTimeoutMs: 1000 },
  } as unknown as PortalConfigService;

  const service = new ProductSyncService(
    products as never,
    (logs as never) ?? ({ save: jest.fn() } as never),
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
