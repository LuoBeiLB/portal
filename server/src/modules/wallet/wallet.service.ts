import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { BizException, ErrorCode } from '../../common/error/error-code';
import { instantToWallIso } from '../../common/time/local-time';
import { toIso } from '../auth/auth.service';
import { WalletStatus } from '../user/entities/user-status.enum';
import { RechargeApplyDto, TransactionQueryDto } from './dto/wallet.dto';
import { RechargeApplyEntity, RechargeStatus } from './entities/recharge-apply.entity';
import { TransactionEntity, TransactionType } from './entities/transaction.entity';
import { WalletEntity } from './entities/wallet.entity';
import { WalletLedgerService } from './wallet-ledger.service';

export interface BalanceView {
  balance_cents: number;
  status: number;
}

export interface TransactionView {
  id: string;
  type: number;
  amount_cents: number;
  balance_after: number;
  product_code: string | null;
  bill_no: string;
  refund_of_bill_no: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface PageView<T> {
  list: T[];
  total: number;
  page: number;
  size: number;
}

@Injectable()
export class WalletService {
  constructor(
    @InjectRepository(WalletEntity) private readonly wallets: Repository<WalletEntity>,
    @InjectRepository(TransactionEntity) private readonly transactions: Repository<TransactionEntity>,
    @InjectRepository(RechargeApplyEntity) private readonly recharges: Repository<RechargeApplyEntity>,
    private readonly ledger: WalletLedgerService,
    private readonly dataSource: DataSource,
  ) {}

  /** 契约 §3.1 余额 */
  async balance(userId: string): Promise<BalanceView> {
    const wallet = await this.ledger.ensureWallet(userId);
    return {
      balance_cents: Number(wallet.balanceCents),
      status: wallet.status === WalletStatus.FROZEN ? 1 : 0,
    };
  }

  /** 契约 §3.2 流水（分页 + type / product_code 过滤），按时间倒序 */
  async listTransactions(userId: string, query: TransactionQueryDto): Promise<PageView<TransactionView>> {
    const size = query.effectiveSize;
    const qb = this.transactions
      .createQueryBuilder('t')
      .where('t.user_id = :userId', { userId })
      .orderBy('t.id', 'DESC')
      .skip((query.page - 1) * size)
      .take(size);

    if (query.type) qb.andWhere('t.type = :type', { type: query.type });
    if (query.product_code) qb.andWhere('t.product_code = :productCode', { productCode: query.product_code });

    const [rows, total] = await qb.getManyAndCount();
    return {
      list: rows.map(toTransactionView),
      total,
      page: query.page,
      size,
    };
  }

  /**
   * 用户端「我的充值记录」（2026-10-10 新增，前端需求单《接口需求_用户端充值记录》）。
   *
   * 为什么需要：用户提交充值申请后走的是**线下转账 + 管理员人工核销**，
   * 在此之前没有任何用户端接口能查核销进度，用户只能干等。
   *
   * `balance_after` 不在 `w_recharge_apply` 表里，而是核销到账时写在流水上
   * （`bill_no = recharge:{apply_id}`），所以这里按 bill_no 精确回查。
   * 未到账（status ≠ 1）时为 null —— 与前端约定一致。
   */
  async listMyRecharges(
    userId: string,
    status: number | undefined,
    page: number,
    size: number,
  ): Promise<PageView<Record<string, unknown>>> {
    const qb = this.recharges
      .createQueryBuilder('r')
      .where('r.user_id = :userId', { userId })
      .orderBy('r.id', 'DESC')
      .skip((page - 1) * size)
      .take(size);

    if (status !== undefined) qb.andWhere('r.status = :status', { status });

    const [rows, total] = await qb.getManyAndCount();

    // 已到账的单据回查「到账后余额」：一次 IN 查询，避免 N+1
    const creditedIds = rows.filter((row) => row.status === RechargeStatus.CONFIRMED).map((row) => row.id);
    const balanceMap = new Map<string, number>();
    if (creditedIds.length > 0) {
      const txns = await this.transactions
        .createQueryBuilder('t')
        .select(['t.billNo', 't.balanceAfter'])
        .where('t.bill_no IN (:...billNos)', { billNos: creditedIds.map((id) => `recharge:${id}`) })
        .getMany();
      for (const txn of txns) {
        const applyId = txn.billNo.replace(/^recharge:/, '');
        balanceMap.set(applyId, Number(txn.balanceAfter));
      }
    }

    return {
      list: rows.map((row) => ({
        apply_id: row.id,
        amount_cents: Number(row.amountCents),
        status: row.status,
        // 仅已到账时非空（流水缺失时也返回 null，不让前端拿到 0 误以为是真实余额）
        balance_after: balanceMap.get(row.id) ?? null,
        reject_reason: row.rejectReason,
        remark: row.remark,
        created_at: toIso(row.createdAt),
      })),
      total,
      page,
      size,
    };
  }

  /**
   * 契约 §3.3 充值申请（人工核销）。
   * 一期唯一入金通道：申请 → 线下转账 → 管理员核销。
   */
  async applyRecharge(
    userId: string,
    dto: RechargeApplyDto,
  ): Promise<{ apply_id: string; status: number; notice: string }> {
    const apply = await this.recharges.save(
      this.recharges.create({
        userId,
        amountCents: String(dto.amount_cents),
        remark: dto.remark ?? null,
        status: RechargeStatus.PENDING,
      }),
    );
    return {
      apply_id: apply.id,
      status: apply.status,
      notice: '请线下转账后等待管理员核销',
    };
  }

  // ---------- 管理端（契约 §6） ----------

  /** 全站流水（管理端导出/排查用，跨用户） */
  async listTransactionsByAdmin(filter: {
    page: number;
    size: number;
    type?: number;
    product_code?: string;
  }): Promise<PageView<TransactionView & { user_id: string }>> {
    const qb = this.transactions.createQueryBuilder('t').orderBy('t.id', 'DESC');
    if (filter.type) qb.andWhere('t.type = :type', { type: filter.type });
    if (filter.product_code) qb.andWhere('t.product_code = :productCode', { productCode: filter.product_code });

    const [rows, total] = await qb
      .skip((filter.page - 1) * filter.size)
      .take(filter.size)
      .getManyAndCount();

    return {
      list: rows.map((row) => ({ ...toTransactionView(row), user_id: row.userId })),
      total,
      page: filter.page,
      size: filter.size,
    };
  }

  /**
   * 管理端导出：按类型 / 产品 / **日期区间**过滤，最多 `limit` 行，按时间倒序。
   *
   * 日期按 UTC 自然日、**含当日**（前端最常用的是"导出某天的流水"）。
   * 导出是数据外泄面，所以由调用方显式给定行数上限，不做无限导出。
   */
  async listTransactionsForExport(filter: {
    limit: number;
    type?: number;
    product_code?: string;
    start_date?: string;
    end_date?: string;
  }): Promise<Array<TransactionView & { user_id: string }>> {
    const qb = this.transactions.createQueryBuilder('t').orderBy('t.id', 'DESC').take(filter.limit);

    if (filter.type) qb.andWhere('t.type = :type', { type: filter.type });
    if (filter.product_code) qb.andWhere('t.product_code = :productCode', { productCode: filter.product_code });
    if (filter.start_date) {
      qb.andWhere('t.created_at >= :start', { start: `${filter.start_date} 00:00:00.000` });
    }
    if (filter.end_date) {
      qb.andWhere('t.created_at <= :end', { end: `${filter.end_date} 23:59:59.999` });
    }

    const rows = await qb.getMany();
    return rows.map((row) => ({ ...toTransactionView(row), user_id: row.userId }));
  }

  /** 充值核销队列 */
  async listRecharges(
    status: number | undefined,
    page: number,
    size: number,
  ): Promise<PageView<Record<string, unknown>>> {
    const qb = this.recharges
      .createQueryBuilder('r')
      .leftJoin('u_user', 'u', 'u.id = r.user_id')
      .addSelect(['u.username', 'u.phone'])
      .orderBy('r.id', 'DESC')
      .skip((page - 1) * size)
      .take(size);

    if (status !== undefined) qb.andWhere('r.status = :status', { status });

    const [rows, total] = await qb.getManyAndCount();

    // 一次查出涉及的「用户」与「核销管理员」，避免 N+1
    const userIds = [...new Set(rows.map((row) => row.userId))];
    const reviewerIds = [...new Set(rows.map((row) => row.reviewedBy).filter((id): id is string => Boolean(id)))];
    const allIds = [...new Set([...userIds, ...reviewerIds])];
    const users = allIds.length
      ? await this.dataSource.query<Array<{ id: string; username: string; phone: string | null }>>(
          `SELECT id, username, phone FROM u_user WHERE id IN (${allIds.map(() => '?').join(',')})`,
          allIds,
        )
      : [];
    const userMap = new Map(users.map((user) => [user.id, user]));

    return {
      list: rows.map((row) => ({
        apply_id: row.id,
        user_id: row.userId,
        username: userMap.get(row.userId)?.username ?? null,
        phone: userMap.get(row.userId)?.phone ?? null,
        amount_cents: Number(row.amountCents),
        remark: row.remark,
        status: row.status,
        created_at: toIso(row.createdAt),
        // `reviewed_at` 是**应用写**的（核销时给 new Date()），库里 UTC 墙面 → 转墙上时间；
        // `created_at` 是库生成的（已是墙上时间）→ toIso 即可。详见 common/time/local-time.ts
        reviewed_at: instantToWallIso(row.reviewedAt),
        // 经办人：reviewed_by 存的是管理员 user_id，这里补上用户名便于管理端展示
        reviewed_by: row.reviewedBy,
        reviewed_by_username: row.reviewedBy ? (userMap.get(row.reviewedBy)?.username ?? null) : null,
        reject_reason: row.rejectReason,
      })),
      total,
      page,
      size,
    };
  }

  /**
   * 契约 §6.2 确认到账 / 驳回。
   *
   * 并发纪律：**条件更新** `WHERE id=? AND status=0`，影响行数 = 0 即"已被处理"，
   * 防止两个管理员同时点通过导致重复增额。到账与写流水在同一事务内。
   */
  async confirmRecharge(
    applyId: string,
    adminId: string,
    reject: boolean,
    rejectReason?: string,
  ): Promise<Record<string, unknown>> {
    // 先做条件更新抢占状态：这一步是并发关口，赢家才继续动钱。
    // 注意不能把 ledger.credit() 套进外层事务：它是独立事务（内部锁定钱包行），
    // 嵌套会导致挂起或死锁。
    const apply = await this.recharges.findOne({ where: { id: applyId } });
    if (!apply) throw new BizException(ErrorCode.PARAM_INVALID, '充值单不存在');

    const nextStatus = reject ? RechargeStatus.REJECTED : RechargeStatus.CONFIRMED;
    const updated = await this.recharges
      .createQueryBuilder()
      .update(RechargeApplyEntity)
      .set({
        status: nextStatus,
        reviewedBy: adminId,
        reviewedAt: new Date(),
        rejectReason: reject ? (rejectReason ?? null) : null,
      })
      .where('id = :id AND status = :pending', { id: applyId, pending: RechargeStatus.PENDING })
      .execute();

    if (Number(updated.affected ?? 0) === 0) {
      throw new BizException(ErrorCode.PARAM_INVALID, '该充值单已被处理', { status: apply.status });
    }

    if (reject) {
      return { apply_id: applyId, status: nextStatus, balance_cents: null };
    }

    try {
      // 到账：加余额 + 写 type=1 流水（幂等键 recharge:<applyId>，同一事务内完成）
      const credit = await this.ledger.credit({
        userId: apply.userId,
        billNo: `recharge:${applyId}`,
        amountCents: Number(apply.amountCents),
        type: TransactionType.RECHARGE,
        detail: { apply_id: applyId, remark: apply.remark ?? undefined },
      });

      return {
        apply_id: applyId,
        status: nextStatus,
        balance_cents: Number(credit.balanceAfter),
        transaction_id: credit.transactionId,
      };
    } catch (error) {
      // 入金失败则退回待核销，避免留下「已到账但没加钱」的悬空单
      await this.recharges
        .createQueryBuilder()
        .update(RechargeApplyEntity)
        .set({ status: RechargeStatus.PENDING, reviewedBy: null, reviewedAt: null })
        .where('id = :id', { id: applyId })
        .execute();
      throw error;
    }
  }
}

export function toTransactionView(row: TransactionEntity): TransactionView {
  return {
    id: row.id,
    type: row.type,
    amount_cents: Number(row.amountCents),
    balance_after: Number(row.balanceAfter),
    product_code: row.productCode,
    bill_no: row.billNo,
    refund_of_bill_no: row.refundOfBillNo,
    detail: row.detail,
    created_at: toIso(row.createdAt) as string,
  };
}
