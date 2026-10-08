import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ReportBillsDto } from '../order/dto/order.dto';
import { TransactionType } from '../wallet/entities/transaction.entity';
import { TransactionEntity } from '../wallet/entities/transaction.entity';
import { ProductBillReportEntity } from './entities/product-bill-report.entity';
import { ReconciliationEntity } from './entities/reconciliation.entity';

export interface ReconciliationView {
  biz_date: string;
  product_code: string;
  portal_amount_cents: number;
  product_amount_cents: number;
  diff_cents: number;
  diff_count: number;
  product_only_count: number;
  portal_only_count: number;
  amount_mismatch_count: number;
  status: 'ok' | 'diff';
  detail: Record<string, unknown> | null;
}

/**
 * 日对账（契约 §6 `GET /admin/reconciliation/daily`）。
 *
 * 口径：**门户流水（w_transaction，type=2/3）vs 产品账单上报（r_product_bill_report）**，按 `bill_no` 逐笔比对。
 *
 * 为什么用"上报"而不是直连：契约明确各产品库结构自定、门户不直连产品库；
 * 产品侧把当日账单推给门户（或用量导出喂进来），门户负责比对与落库。
 *
 * 每日 04:10 自动跑前一日（UTC）；也可手动触发补跑。
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    @InjectRepository(TransactionEntity) private readonly transactions: Repository<TransactionEntity>,
    @InjectRepository(ProductBillReportEntity) private readonly reports: Repository<ProductBillReportEntity>,
    @InjectRepository(ReconciliationEntity) private readonly reconciliations: Repository<ReconciliationEntity>,
  ) {}

  /** 每日 04:10（UTC）对前一日做对账 */
  @Cron('0 10 4 * * *')
  async dailyJob(): Promise<void> {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const codes = await this.knownProductCodes(yesterday);
    for (const code of codes) {
      try {
        await this.reconcile(yesterday, code);
      } catch (error) {
        this.logger.error(`对账失败 date=${yesterday} product=${code}：${(error as Error).message}`);
      }
    }
  }

  /** 产品账单上报（契约外补充接口，产品侧调用） */
  async reportBills(dto: ReportBillsDto): Promise<{ accepted: number }> {
    let accepted = 0;
    for (const bill of dto.bills) {
      const result = await this.reports
        .createQueryBuilder()
        .insert()
        .into(ProductBillReportEntity)
        .values({
          bizDate: dto.biz_date,
          productCode: dto.product_code,
          billNo: bill.bill_no,
          portalUserId: bill.portal_user_id ?? null,
          amountCents: String(bill.amount_cents),
          type: bill.type ?? 2,
          relatedBillNo: bill.related_bill_no ?? null,
        })
        .orUpdate(['amount_cents', 'type', 'portal_user_id', 'related_bill_no'], ['biz_date', 'product_code', 'bill_no'])
        .execute();
      if (result.identifiers.length > 0 || Number(result.raw?.affectedRows ?? 0) >= 0) accepted += 1;
    }
    return { accepted };
  }

  /** 执行对账并落库（同一 date+product 重复跑会覆盖上一次结果） */
  async reconcile(bizDate: string, productCode: string): Promise<ReconciliationView> {
    const portalRows = await this.transactions
      .createQueryBuilder('t')
      .where('t.product_code = :productCode', { productCode })
      .andWhere('t.type IN (:...types)', { types: [TransactionType.DEDUCT, TransactionType.REFUND] })
      .andWhere('DATE(t.created_at) = :bizDate', { bizDate })
      .getMany();

    const productRows = await this.reports.find({ where: { bizDate, productCode } });

    const portalMap = new Map(portalRows.map((row) => [row.billNo, Number(row.amountCents)]));
    const productMap = new Map(productRows.map((row) => [row.billNo, Number(row.amountCents)]));

    const productOnly: string[] = [];
    const portalOnly: string[] = [];
    const amountMismatch: Array<{ bill_no: string; portal_cents: number; product_cents: number }> = [];

    for (const [billNo, amount] of productMap) {
      if (!portalMap.has(billNo)) productOnly.push(billNo);
      else if (portalMap.get(billNo) !== amount) {
        amountMismatch.push({ bill_no: billNo, portal_cents: portalMap.get(billNo)!, product_cents: amount });
      }
    }
    for (const billNo of portalMap.keys()) {
      if (!productMap.has(billNo)) portalOnly.push(billNo);
    }

    const portalAmount = sum([...portalMap.values()]);
    const productAmount = sum([...productMap.values()]);
    const diffCents = portalAmount - productAmount;
    const diffCount = productOnly.length + portalOnly.length + amountMismatch.length;
    const status: 'ok' | 'diff' = diffCount === 0 && diffCents === 0 ? 'ok' : 'diff';

    const detail = {
      product_only: productOnly.slice(0, 200),
      portal_only: portalOnly.slice(0, 200),
      amount_mismatch: amountMismatch.slice(0, 200),
    };

    const view: ReconciliationView = {
      biz_date: bizDate,
      product_code: productCode,
      portal_amount_cents: portalAmount,
      product_amount_cents: productAmount,
      diff_cents: diffCents,
      diff_count: diffCount,
      product_only_count: productOnly.length,
      portal_only_count: portalOnly.length,
      amount_mismatch_count: amountMismatch.length,
      status,
      detail,
    };

    await this.reconciliations
      .createQueryBuilder()
      .insert()
      .into(ReconciliationEntity)
      .values({
        bizDate,
        productCode,
        portalAmountCents: String(portalAmount),
        productAmountCents: String(productAmount),
        diffCents: String(diffCents),
        diffCount,
        productOnlyCount: productOnly.length,
        portalOnlyCount: portalOnly.length,
        amountMismatchCount: amountMismatch.length,
        detail,
        status,
      })
      .orUpdate(
        [
          'portal_amount_cents',
          'product_amount_cents',
          'diff_cents',
          'diff_count',
          'product_only_count',
          'portal_only_count',
          'amount_mismatch_count',
          'detail',
          'status',
        ],
        ['biz_date', 'product_code'],
      )
      .execute();

    if (status === 'diff') {
      this.logger.warn(
        `对账有差异 date=${bizDate} product=${productCode} diff_cents=${diffCents} diff_count=${diffCount}`,
      );
    }
    return view;
  }

  /** 查询某日对账结果（契约 §6 管理端接口） */
  async queryDaily(bizDate?: string): Promise<{ list: ReconciliationView[] }> {
    const date = bizDate ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rows = await this.reconciliations.find({ where: { bizDate: date }, order: { productCode: 'ASC' } });
    return {
      list: rows.map((row) => ({
        biz_date: row.bizDate,
        product_code: row.productCode,
        portal_amount_cents: Number(row.portalAmountCents),
        product_amount_cents: Number(row.productAmountCents),
        diff_cents: Number(row.diffCents),
        diff_count: row.diffCount,
        product_only_count: row.productOnlyCount,
        portal_only_count: row.portalOnlyCount,
        amount_mismatch_count: row.amountMismatchCount,
        status: row.status === 'ok' ? 'ok' : 'diff',
        detail: row.detail,
      })),
    };
  }

  private async knownProductCodes(bizDate: string): Promise<string[]> {
    const rows = await this.reports
      .createQueryBuilder('r')
      .select('DISTINCT r.product_code', 'code')
      .where('r.biz_date = :bizDate', { bizDate })
      .getRawMany<{ code: string }>();
    return rows.map((row) => row.code);
  }
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}
