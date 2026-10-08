import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
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

  constructor(
    @InjectRepository(ProductEntity) private readonly products: Repository<ProductEntity>,
    @InjectRepository(ProductSyncLogEntity) private readonly logs: Repository<ProductSyncLogEntity>,
    private readonly client: ProductClient,
    private readonly config: PortalConfigService,
  ) {}

  /** 定时全量同步（默认 10 分钟，见 PRODUCT_SYNC_INTERVAL_MS） */
  @Cron(CronExpression.EVERY_MINUTE)
  async scheduledSync(): Promise<void> {
    const intervalMs = this.config.shop.productSyncIntervalMs;
    const last = await this.logs.find({ order: { id: 'DESC' }, take: 1 });
    const lastAt = last[0]?.startedAt ? new Date(last[0].startedAt).getTime() : 0;
    // 没有历史记录（首次启动/日志被清）时要立刻同步，不能空等一个周期
    const neverSynced = last.length === 0;
    if (!neverSynced && Date.now() - lastAt < intervalMs) return;

    await this.syncAll();
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

  /** 契约 §2.1 商品列表（用户端）。product_code 可选过滤；只返回在售商品 */
  async listForShop(productCode?: string): Promise<{ list: ProductView[] }> {
    const rows = await this.products.find({
      where: productCode ? { productCode, isActive: 1 } : { isActive: 1 },
      order: { productCode: 'ASC', priceCents: 'ASC' },
    });
    return { list: rows.map(toProductView) };
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
