import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BizException, ErrorCode } from '../../common/error-code';
import { ProductEndpoint } from '../../config/configuration';
import { PortalConfigService } from '../../config/portal-config.service';
import { BillingMode, ProductEntity } from './entities/product.entity';
import { ProductSyncLogEntity } from './entities/product-sync-log.entity';
import { ProductClient, RemoteProduct } from './product.client';

export interface SyncResult {
  product_code: string;
  fetched: number;
  upserted: number;
  deactivated: number;
  status: 'ok' | 'failed';
  error?: string;
}

export interface ProductView {
  product_code: string;
  sku_id: string;
  name: string;
  spec: Record<string, unknown> | null;
  price_cents: number;
  billing_mode: number;
  period_days: number | null;
  stock: number | null;
  synced_at: string;
}

/**
 * 商品列表响应（含**目录新鲜度**，2026-10-12 新增）。
 *
 * 为什么加：同步失败时门户**保留上一次成功的目录**（宁愿卖旧价也不让商城空掉），
 * 于是会出现"日志一直在报同步失败，但商品列表照常返回"的现象——
 * 前端和用户都看不出这些是**旧价格**。
 *
 * `catalog.stale = true` 就是给前端的信号：可以照常展示，但应提示
 * 「价格可能不是最新，下单前请确认」；管理端也可以据此报警。
 */
export interface ProductListView {
  list: ProductView[];
  catalog: {
    /** true = 最近一次同步失败，或目录超过 STALE 阈值（默认 3 个同步周期）没更新 */
    stale: boolean;
    /** 最近一次同步**尝试**的时间（失败也算尝试），UTC ISO 8601；从未同步过为 null */
    last_sync_at: string | null;
    /** 最近一次同步是否成功 */
    last_sync_ok: boolean | null;
    /** 最近一次失败原因；成功或无记录为 null */
    last_error: string | null;
    /** 目录里最新一条商品的同步时间（= 当前展示价格的"新鲜度"），无商品为 null */
    data_synced_at: string | null;
  };
}

/**
 * 商品目录同步（契约 §5.1）。
 *
 * 契约要求：门户**每 10 分钟全量拉取 upsert**（product_code + sku_id 匹配），产品调价后最迟 10 分钟生效。
 *
 * 两个容易踩的点：
 * 1. 产品**不再上报**的 sku 置 `is_active = 0` **软下架**，绝不物理删除 —— 否则历史订单项按 sku_id 展示会断档；
 * 2. 同步失败不能抛给调度器（否则 Nest 会刷错误日志），一律记录到 `p_product_sync_log` 便于排查"调价为什么没生效"。
 */
@Injectable()
export class ProductSyncService {
  private readonly logger = new Logger(ProductSyncService.name);

  /** 商品列表进程内缓存：key = product_code（未过滤时为 '*'） */
  private readonly listCache = new Map<string, { value: ProductListView; expiresAt: number }>();

  /** 连续失败次数：用于失败后的退避重试，避免产品挂掉时每 15 秒猛打 */
  private consecutiveFailures = 0;

  constructor(
    @InjectRepository(ProductEntity) private readonly products: Repository<ProductEntity>,
    @InjectRepository(ProductSyncLogEntity) private readonly logs: Repository<ProductSyncLogEntity>,
    private readonly client: ProductClient,
    private readonly config: PortalConfigService,
  ) {}

  /**
   * 商品目录同步（契约 §5.1）。
   *
   * ## 为什么用 `@Interval` 而不是 `@Cron(EVERY_MINUTE)`
   *
   * cron 的"每分钟"指**每个整分的第 0 秒**，不是"每隔 60 秒"：
   * 服务在 10:00:30 启动时，第一次同步要等到 10:01:00 —— 最长空窗 60 秒。
   * 实测被前端撞上过（`GET /shop/products` 返回空列表，前端以为"后端没接商品"）。
   * `@Interval` 是**相对启动时间**计时，首次检查在启动后 15 秒。
   *
   * ## 守卫为什么不能只看"上次同步时间"（2026-10-10 修）
   *
   * 原实现只比较 `now - 上次startedAt < intervalMs`，**不看上次结果**。后果：
   * 一次偶发失败（超时）或一次"成功但返回 0 条"，都会被当成"刚同步过"，
   * **10 分钟内不再重试**；而本地商品表是空的 → 商品列表一直空
   * → 前端以为"门户没连上云存储"。清空过商品表时更会**永久卡死**。
   *
   * 现在的规则：
   * 1. 本地商品表为空 → **必须同步**，不看间隔（空目录会直接打断"浏览→下单"主流程）
   * 2. 上次同步失败 → 退避重试（15s / 30s / 60s，上限一个正常周期）
   * 3. 正常情况 → 按 `PRODUCT_SYNC_INTERVAL_MS`（默认 10 分钟）
   */
  @Interval(15_000)
  async scheduledSync(): Promise<void> {
    const intervalMs = this.config.shop.productSyncIntervalMs;

    // 规则 1：本地目录空 → 立刻同步，不受间隔限制
    const localCount = await this.products.count();
    if (localCount === 0) {
      this.logger.warn('本地商品目录为空，立即触发同步（不受同步间隔限制）');
      await this.runSync();
      return;
    }

    const last = await this.logs.find({ order: { id: 'DESC' }, take: 1 });
    const lastRow = last[0];
    const lastAt = lastRow?.startedAt ? new Date(lastRow.startedAt).getTime() : 0;
    // 没有历史记录（首次启动/日志被清）时要立刻同步，不能空等一个周期
    const neverSynced = last.length === 0;
    if (neverSynced) {
      await this.runSync();
      return;
    }

    // 规则 2：上次失败 → 退避重试（15s → 30s → 60s，最多不超过一个正常周期）
    // `status` 是 tinyint：0 成功 / 1 失败（见 ProductSyncLogEntity 注释）
    if (lastRow.status === 1) {
      const backoff = Math.min(15_000 * 2 ** Math.max(0, this.consecutiveFailures - 1), intervalMs);
      if (Date.now() - lastAt < backoff) return;
      this.logger.warn(`上次同步失败（${lastRow.errorMsg ?? '未知原因'}），退避 ${Math.round(backoff / 1000)}s 后重试`);
      await this.runSync();
      return;
    }

    // 规则 3：正常周期
    if (Date.now() - lastAt < intervalMs) return;
    await this.runSync();
  }

  /** 跑一轮同步并维护失败计数 */
  private async runSync(): Promise<void> {
    const results = await this.syncAll();
    const failed = results.filter((item) => item.status === 'failed').length;
    const empty = results.filter((item) => item.status === 'ok' && item.fetched === 0).length;

    if (failed > 0 || empty > 0) {
      this.consecutiveFailures += 1;
      if (empty > 0) {
        this.logger.warn(`有 ${empty} 个产品返回了 0 条商品（保存商品已在产品侧下架，需确认产品侧目录）`);
      }
    } else {
      this.consecutiveFailures = 0;
    }
  }

  /** 参与同步的产品（地址留空的视为未接入，不刷错误日志） */
  enabledEndpoints(): ProductEndpoint[] {
    return this.client.endpoints().filter((endpoint) => endpoint.enabled);
  }

  /** 全量同步所有**已接入**的产品；单个产品失败不影响其他产品 */
  async syncAll(): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const endpoint of this.enabledEndpoints()) {
      results.push(await this.syncOne(endpoint.code));
    }
    const failed = results.filter((item) => item.status === 'failed');
    if (failed.length > 0) {
      this.logger.warn(`商品同步完成，${failed.length} 个产品失败：${failed.map((f) => f.product_code).join(',')}`);
    } else if (results.length > 0) {
      const total = results.reduce((sum, item) => sum + item.upserted, 0);
      this.logger.log(`商品同步完成：${results.length} 个产品，共 upsert ${total} 条`);
    }
    return results;
  }

  /** 同步单个产品 */
  async syncOne(productCode: string): Promise<SyncResult> {
    const log = await this.logs.save(
      this.logs.create({
        productCode,
        startedAt: new Date(),
        fetchedCount: 0,
        upsertedCount: 0,
        deactivatedCount: 0,
        status: 0,
      }),
    );

    try {
      const remote = await this.client.fetchProducts(productCode);
      const { upserted, deactivated } = await this.upsert(productCode, remote);

      log.finishedAt = new Date();
      log.fetchedCount = remote.length;
      log.upsertedCount = upserted;
      log.deactivatedCount = deactivated;
      log.status = 0;
      await this.logs.save(log);

      // 商品有变动（含软下架）→ 立刻失效列表缓存，避免调价被缓存挡住
      this.clearListCache();

      return { product_code: productCode, fetched: remote.length, upserted, deactivated, status: 'ok' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.finishedAt = new Date();
      log.status = 1;
      log.errorMsg = message.slice(0, 500);
      await this.logs.save(log);
      this.logger.error(`商品同步失败 product=${productCode}：${message}`);
      return { product_code: productCode, fetched: 0, upserted: 0, deactivated: 0, status: 'failed', error: message };
    }
  }

  private async upsert(
    productCode: string,
    remote: RemoteProduct[],
  ): Promise<{ upserted: number; deactivated: number }> {
    const now = new Date();
    const seen: string[] = [];

    for (const item of remote) {
      if (!item?.sku_id) continue;
      seen.push(item.sku_id);

      const existing = await this.products.findOne({ where: { productCode, skuId: item.sku_id } });
      const payload = {
        productCode,
        skuId: item.sku_id,
        name: item.name?.slice(0, 128) ?? item.sku_id,
        spec: (item.spec ?? null) as Record<string, unknown> | null,
        priceCents: Math.max(0, Math.trunc(Number(item.price_cents) || 0)),
        billingMode: (Number(item.billing_mode) === 2 ? BillingMode.USAGE : BillingMode.PERIOD) as BillingMode,
        periodDays: item.period_days === undefined || item.period_days === null ? null : Number(item.period_days),
        stock: item.stock === undefined || item.stock === null ? null : Number(item.stock),
        isActive: 1,
        syncedAt: now,
      };

      if (existing) {
        // 用 save 而不是 update：spec 是 JSON 列，QueryDeepPartialEntity 对 JSON 的类型推断过窄
        await this.products.save(this.products.merge(existing, payload));
      } else {
        await this.products.save(this.products.create(payload));
      }
    }

    // 本轮未上报的旧 sku → 软下架（保留行，避免历史订单项断档）
    const existingRows = await this.products.find({ where: { productCode } });
    const stale = existingRows.filter((row) => row.isActive === 1 && !seen.includes(row.skuId));
    if (stale.length > 0) {
      for (const row of stale) {
        row.isActive = 0;
        row.syncedAt = now;
      }
      await this.products.save(stale);
    }

    return { upserted: seen.length, deactivated: stale.length };
  }

  /**
   * 契约 §2.1 商品列表（**公开接口**，游客可见）。product_code 可选过滤；只返回在售商品。
   *
   * 带进程内 TTL 缓存：商品每 10 分钟才同步一次，同一份响应在周期内完全相同，
   * 而这是公开接口，不打缓存会被无限刷库。TTL 默认 10 秒（远小于同步周期，用户无感知），
   * 且每次同步成功后会**主动失效**，所以调价不会因为缓存而延迟生效。
   *
   * ⚠️ **同步失败时这里照常返回旧目录**（有意为之：不让商城整个空掉），
   * 因此响应里带 `catalog.stale` 让前端能提示"价格可能不是最新"。见 `ProductListView`。
   */
  async listForShop(productCode?: string): Promise<ProductListView> {
    const ttlMs = this.config.shop.productListCacheTtlMs;
    const cacheKey = productCode ?? '*';

    if (ttlMs > 0) {
      const cached = this.listCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
    }

    const rows = await this.products.find({
      where: productCode ? { productCode, isActive: 1 } : { isActive: 1 },
      order: { productCode: 'ASC', priceCents: 'ASC' },
    });
    const value: ProductListView = {
      list: rows.map(toProductView),
      catalog: await this.catalogFreshness(rows),
    };

    if (ttlMs > 0) this.listCache.set(cacheKey, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  /**
   * 计算目录新鲜度。
   *
   * `stale` 为 true 的三种情况：
   * 1. **从未同步过**（没有同步日志）—— 没成功同步过的目录不该被当成新鲜
   * 2. 最近一次同步**失败**（最直观：日志里正在报错）
   * 3. 目录数据超过 `3 × 同步周期` 没更新 —— 覆盖"同步一直成功但拿到 0 条"这种
   *
   * 阈值取 3 个周期：单次失败不报警（会自动退避重试），持续失败才提示。
   */
  private async catalogFreshness(rows: ProductEntity[]): Promise<ProductListView['catalog']> {
    const last = await this.logs.find({ order: { id: 'DESC' }, take: 1 });
    const lastRow = last[0] ?? null;

    const syncedTimes = rows
      .map((row) => (row.syncedAt ? new Date(row.syncedAt).getTime() : null))
      .filter((value): value is number => value !== null && !Number.isNaN(value));
    const dataSyncedAt = syncedTimes.length > 0 ? new Date(Math.max(...syncedTimes)) : null;

    const staleThresholdMs = this.config.shop.productSyncIntervalMs * 3;
    const tooOld = dataSyncedAt === null || Date.now() - dataSyncedAt.getTime() > staleThresholdMs;
    const neverSynced = lastRow === null;

    return {
      stale: neverSynced || tooOld || lastRow.status === 1,
      last_sync_at: lastRow?.startedAt ? new Date(lastRow.startedAt).toISOString() : null,
      last_sync_ok: lastRow ? lastRow.status === 0 : null,
      last_error: lastRow?.errorMsg ?? null,
      data_synced_at: dataSyncedAt ? dataSyncedAt.toISOString() : null,
    };
  }

  /** 清空商品列表缓存（同步成功后调用，保证调价立刻可见） */
  private clearListCache(): void {
    if (this.listCache.size > 0) this.listCache.clear();
  }

  /** 下单/支付前的二次校验：必须存在且在售（契约 §2.2 明确创建时校验，支付时二次校验） */
  async requireActive(productCode: string, skuId: string): Promise<ProductEntity> {
    const product = await this.products.findOne({ where: { productCode, skuId } });
    if (!product || product.isActive !== 1) throw new BizException(ErrorCode.PRODUCT_NOT_FOUND);
    return product;
  }
}

export function toProductView(row: ProductEntity): ProductView {
  return {
    product_code: row.productCode,
    sku_id: row.skuId,
    name: row.name,
    spec: row.spec,
    price_cents: row.priceCents,
    billing_mode: row.billingMode,
    period_days: row.periodDays,
    stock: row.stock,
    synced_at: new Date(row.syncedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}
