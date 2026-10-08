import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, Repository } from 'typeorm';

import { PortalConfigService } from '../../config/portal-config.service';
import { ProductEntity } from '../product/entities/product.entity';
import { ProductClient, ProvisionError } from '../product/product.client';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import { OrderItemEntity, OrderItemStatus } from './entities/order-item.entity';
import { ProvisionJobEntity, ProvisionJobStatus } from './entities/provision-job.entity';
import { OrderService } from './order.service';

/**
 * 开通任务 worker（契约 §5.2 的调用方）。
 *
 * 为什么单独跑：产品 provision 单次超时 30s，放在 HTTP 请求里会拖垮连接池。
 * 这里每 3 秒扫一次队列，逐条串行处理，失败按退避重试，用尽次数则**自动退款**（契约 §2.4）。
 *
 * 三条关键纪律：
 * 1. **认领要原子**：用条件更新把 pending → processing，避免多实例重复处理；
 * 2. **卡死可恢复**：processing 超过 staleMs 的任务重新放回队列（进程被杀的保护）；
 * 3. **退款幂等**：`refund:{order_item_id}:{attempts}` 作为退款单号，重试不会重复退。
 */
@Injectable()
export class ProvisionWorker {
  private readonly logger = new Logger(ProvisionWorker.name);
  private running = false;

  constructor(
    @InjectRepository(ProvisionJobEntity) private readonly jobs: Repository<ProvisionJobEntity>,
    @InjectRepository(OrderItemEntity) private readonly items: Repository<OrderItemEntity>,
    @InjectRepository(ProductEntity) private readonly products: Repository<ProductEntity>,
    private readonly dataSource: DataSource,
    private readonly client: ProductClient,
    private readonly ledger: WalletLedgerService,
    private readonly orders: OrderService,
    private readonly config: PortalConfigService,
  ) {}

  /** 每 3 秒跑一轮（用 running 标志防重入，避免上一轮没跑完又起一轮） */
  @Interval(3000)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reclaimStale();
      const claimed = await this.claimBatch();
      for (const job of claimed) {
        await this.process(job);
      }
    } catch (error) {
      this.logger.error(`开通任务轮询异常：${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** 手动推进一轮（管理端排障用） */
  async runOnce(): Promise<{ processed: number }> {
    const claimed = await this.claimBatch();
    for (const job of claimed) await this.process(job);
    return { processed: claimed.length };
  }

  /** 认领一批待处理任务：条件更新保证同一任务只会被一个 worker 拿到 */
  private async claimBatch(): Promise<ProvisionJobEntity[]> {
    const batchSize = this.config.shop.provisionBatchSize;
    const candidates = await this.jobs.find({
      where: { status: ProvisionJobStatus.PENDING, nextRunAt: LessThan(new Date()) },
      order: { id: 'ASC' },
      take: batchSize,
    });
    if (candidates.length === 0) return [];

    const ids = candidates.map((job) => job.id);
    const claimedAt = new Date();
    await this.jobs
      .createQueryBuilder()
      .update(ProvisionJobEntity)
      .set({ status: ProvisionJobStatus.PROCESSING, claimedAt })
      .where('id IN (:...ids) AND status = :pending', { ids, pending: ProvisionJobStatus.PENDING })
      .execute();

    return this.jobs.find({
      where: { id: In(ids), status: ProvisionJobStatus.PROCESSING, claimedAt },
      order: { id: 'ASC' },
    });
  }

  /** 认领后长时间没结束的任务重新入队（处理过程中进程被杀） */
  private async reclaimStale(): Promise<void> {
    const threshold = new Date(Date.now() - this.config.shop.provisionStaleMs);
    const result = await this.jobs
      .createQueryBuilder()
      .update(ProvisionJobEntity)
      .set({ status: ProvisionJobStatus.PENDING, nextRunAt: new Date(), lastError: '任务超时被重新入队' })
      .where('status = :processing AND claimed_at < :threshold', {
        processing: ProvisionJobStatus.PROCESSING,
        threshold,
      })
      .execute();
    if (Number(result.affected ?? 0) > 0) {
      this.logger.warn(`重新入队卡死的开通任务 ${result.affected} 条`);
    }
  }

  /** 处理单条任务 */
  async process(job: ProvisionJobEntity): Promise<void> {
    const item = await this.items.findOne({ where: { id: job.orderItemId } });
    if (!item) {
      await this.markJobFailed(job, '订单项不存在');
      return;
    }
    // 幂等保护：已经开通成功或已退款的项不再处理
    if (item.status === OrderItemStatus.PROVISIONED || item.status === OrderItemStatus.REFUNDED) {
      await this.jobs.update({ id: job.id }, { status: ProvisionJobStatus.SUCCEEDED, claimedAt: null });
      return;
    }

    const attempt = job.attempts + 1;
    try {
      // 周期天数取自商品缓存（订单项只快照了价格，不存周期）
      const product = await this.products.findOne({
        where: { productCode: item.productCode, skuId: item.skuId },
      });

      const result = await this.client.provision(job.productCode, {
        order_item_id: job.orderItemId,
        portal_user_id: job.userId,
        sku_id: item.skuId,
        quantity: item.quantity,
        period_days: product?.periodDays ?? null,
      });

      await this.dataSource.transaction(async (manager) => {
        await manager.update(
          OrderItemEntity,
          { id: item.id },
          {
            status: OrderItemStatus.PROVISIONED,
            instanceId: result.instance_id,
            expireAt: result.expire_at ? new Date(result.expire_at) : null,
            failReason: null,
          },
        );
        await manager.update(
          ProvisionJobEntity,
          { id: job.id },
          { status: ProvisionJobStatus.SUCCEEDED, attempts: attempt, claimedAt: null, lastError: null },
        );
        await this.orders.refreshOrderStatus(manager, job.orderId);
      });

      this.logger.log(`开通成功 order_item=${job.orderItemId} instance=${result.instance_id}`);
    } catch (error) {
      const provisionError = error instanceof ProvisionError ? error : null;
      const retryable = provisionError?.retryable ?? true;
      const message = error instanceof Error ? error.message : String(error);
      const canRetry = retryable && attempt < job.maxAttempts;

      if (canRetry) {
        // 退避重试：契约 §5.2 允许门户用同一 order_item_id 重试（产品侧幂等）
        const delay = Math.min(2000 * attempt, this.config.shop.provisionTimeoutMs);
        await this.jobs.update(
          { id: job.id },
          {
            status: ProvisionJobStatus.PENDING,
            attempts: attempt,
            claimedAt: null,
            nextRunAt: new Date(Date.now() + delay),
            lastError: message.slice(0, 500),
          },
        );
        this.logger.warn(`开通失败将重试(${attempt}/${job.maxAttempts}) order_item=${job.orderItemId}：${message}`);
        return;
      }

      await this.refundAndFail(job, item, attempt, message, retryable);
    }
  }

  /**
   * 开通最终失败 → 自动退款（契约 §2.4：失败/超时则调门户退款，item.status = 4）。
   * 退款本身失败不阻断流程：把项置为 3（失败待退款）交由对账处理，避免"钱扣了没人管"。
   */
  private async refundAndFail(
    job: ProvisionJobEntity,
    item: OrderItemEntity,
    attempt: number,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    const amount = Number(item.priceCents);
    const reason = retryable ? 'PROVISION_FAILED' : (message.match(/code=(\d+)/)?.[1] ?? 'PROVISION_REJECTED');

    if (amount === 0) {
      // 按量计费/0 元订单没有钱可退
      await this.dataSource.transaction(async (manager) => {
        await manager.update(
          OrderItemEntity,
          { id: item.id },
          { status: OrderItemStatus.REFUNDED, failReason: reason },
        );
        await manager.update(
          ProvisionJobEntity,
          { id: job.id },
          { status: ProvisionJobStatus.FAILED, attempts: attempt, claimedAt: null, lastError: message.slice(0, 500) },
        );
        await this.orders.refreshOrderStatus(manager, job.orderId);
      });
      return;
    }

    try {
      await this.ledger.refund({
        userId: job.userId,
        // 与支付时的逐项扣费幂等键对应（契约 §2.4：bill_no = order:{order_id}:item:{item_id}）
        billNo: `order:${job.orderId}:item:${job.orderItemId}`,
        refundBillNo: `refund:${job.orderItemId}:${attempt}`,
        amountCents: amount,
        reason: `开通失败自动退款：${reason}`,
      });

      await this.dataSource.transaction(async (manager) => {
        await manager.update(
          OrderItemEntity,
          { id: item.id },
          { status: OrderItemStatus.REFUNDED, failReason: reason },
        );
        await manager.update(
          ProvisionJobEntity,
          { id: job.id },
          { status: ProvisionJobStatus.FAILED, attempts: attempt, claimedAt: null, lastError: message.slice(0, 500) },
        );
        await this.orders.refreshOrderStatus(manager, job.orderId);
      });
      this.logger.warn(`开通失败已自动退款 order_item=${job.orderItemId} amount=${amount} reason=${reason}`);
    } catch (refundError) {
      this.logger.error(
        `自动退款失败，标记为待退款人工处理 order_item=${job.orderItemId}：${(refundError as Error).message}`,
      );
      await this.dataSource.transaction(async (manager) => {
        await manager.update(
          OrderItemEntity,
          { id: item.id },
          { status: OrderItemStatus.FAILED_PENDING_REFUND, failReason: reason },
        );
        await manager.update(
          ProvisionJobEntity,
          { id: job.id },
          {
            status: ProvisionJobStatus.FAILED,
            attempts: attempt,
            claimedAt: null,
            lastError: `退款失败：${(refundError as Error).message}`.slice(0, 500),
          },
        );
        await this.orders.refreshOrderStatus(manager, job.orderId);
      });
    }
  }

  private async markJobFailed(job: ProvisionJobEntity, reason: string): Promise<void> {
    await this.jobs.update(
      { id: job.id },
      { status: ProvisionJobStatus.FAILED, claimedAt: null, lastError: reason.slice(0, 500) },
    );
  }

  /** 供对账参考：统计各状态任务数 */
  async stats(): Promise<Record<string, number>> {
    const rows = await this.jobs
      .createQueryBuilder('j')
      .select('j.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('j.status')
      .getRawMany<{ status: number; count: string }>();
    return rows.reduce<Record<string, number>>((acc, row) => {
      acc[String(row.status)] = Number(row.count);
      return acc;
    }, {});
  }
}
