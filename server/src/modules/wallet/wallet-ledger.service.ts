import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { BizException, ErrorCode } from '../../common/error-code';
import { WalletStatus } from '../user/entities/user-status.enum';
import { TransactionEntity, TransactionType } from './entities/transaction.entity';
import { WalletEntity } from './entities/wallet.entity';

export interface DeductResult {
  /** 本次扣费后的余额（分） */
  balanceAfter: string;
  transactionId: string;
  /** true = 命中幂等键，返回首次结果 */
  idempotentRepeated: boolean;
}

export interface RefundResult {
  balanceAfter: string;
  transactionId: string;
  idempotentRepeated: boolean;
}

/**
 * 钱包资金操作 —— 门户里最不能出错的一段，纪律写死在方法注释里：
 *
 * 1. **扣费只走条件原子更新**（契约 §0.5）：
 *    `UPDATE w_wallet SET balance_cents = balance_cents - ? WHERE user_id=? AND status=0 AND balance_cents>=?`
 *    影响行数 = 0 → 余额不足(3001) 或冻结(3002)；不依赖读-改-写，天然防并发超扣。
 * 2. **幂等键 bill_no 唯一索引兜底**：重复提交返回首次结果（3003 / idempotent_repeated=true）。
 * 3. **余额变更与流水写入必须在同一事务内**，否则对账会出现"钱动了没流水"。
 * 4. 退款累计校验（3004）：该原单已退金额 + 本次 <= 原单金额。
 */
@Injectable()
export class WalletLedgerService {
  constructor(
    @InjectRepository(WalletEntity) private readonly wallets: Repository<WalletEntity>,
    @InjectRepository(TransactionEntity) private readonly transactions: Repository<TransactionEntity>,
  ) {}

  async ensureWallet(userId: string): Promise<WalletEntity> {
    const wallet = await this.wallets.findOne({ where: { userId } });
    if (wallet) return wallet;
    await this.wallets.insert({ userId, balanceCents: '0' });
    return this.wallets.findOneOrFail({ where: { userId } });
  }

  /** 扣费（供契约 §4.1 内网接口使用；门户内部下单扣费复用同一入口） */
  async deduct(input: {
    userId: string;
    billNo: string;
    amountCents: number;
    productCode: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<DeductResult> {
    if (input.amountCents <= 0) {
      throw new BizException(ErrorCode.PARAM_INVALID, 'amount_cents 必须大于 0');
    }

    // 幂等：命中即返回首次结果
    const existing = await this.findByBillNo(input.billNo);
    if (existing) {
      return {
        balanceAfter: existing.balanceAfter,
        transactionId: existing.id,
        idempotentRepeated: true,
      };
    }

    return this.transactions.manager.transaction(async (manager) => {
      // 扣费只靠下面这条条件原子更新保证正确性；这里不额外加行锁，避免与原子更新语义重复。
      const updated = await manager
        .createQueryBuilder()
        .update(WalletEntity)
        .set({ balanceCents: () => `balance_cents - ${input.amountCents}` })
        .where('user_id = :userId AND status = :status AND balance_cents >= :amount', {
          userId: input.userId,
          status: WalletStatus.NORMAL,
          amount: input.amountCents,
        })
        .execute();

      if (Number(updated.affected ?? 0) === 0) {
        const wallet = await manager.findOne(WalletEntity, { where: { userId: input.userId } });
        if (!wallet) throw new BizException(ErrorCode.INTERNAL_ERROR, '钱包不存在');
        if (wallet.status === WalletStatus.FROZEN) throw new BizException(ErrorCode.WALLET_FROZEN);
        throw new BizException(ErrorCode.INSUFFICIENT_BALANCE, undefined, {
          balance: Number(wallet.balanceCents),
        });
      }

      const wallet = await manager.findOneOrFail(WalletEntity, { where: { userId: input.userId } });
      const txn = await this.insertTransaction(manager, {
        userId: input.userId,
        type: TransactionType.DEDUCT,
        amountCents: input.amountCents,
        balanceAfter: wallet.balanceCents,
        billNo: input.billNo,
        productCode: input.productCode,
        detail: input.detail ?? null,
      });

      return { balanceAfter: wallet.balanceCents, transactionId: txn.id, idempotentRepeated: false };
    });
  }

  /**
   * 在**调用方已有的 MySQL 事务内**扣费。
   *
   * 用途：订单支付的「扣费 + 订单项状态 + 入队开通任务」必须原子提交 ——
   * 否则可能出现「钱扣了但订单项没更新」这种最糟糕的中间态。
   * 因此把扣费逻辑暴露成可传入 manager 的版本。
   */
  async deductWithin(
    manager: EntityManager,
    input: {
      userId: string;
      billNo: string;
      amountCents: number;
      productCode: string | null;
      detail?: Record<string, unknown> | null;
    },
  ): Promise<DeductResult> {
    if (input.amountCents <= 0) {
      throw new BizException(ErrorCode.PARAM_INVALID, 'amount_cents 必须大于 0');
    }

    const existing = await manager.findOne(TransactionEntity, { where: { billNo: input.billNo } });
    if (existing) {
      return { balanceAfter: existing.balanceAfter, transactionId: existing.id, idempotentRepeated: true };
    }

    const updated = await manager
      .createQueryBuilder()
      .update(WalletEntity)
      .set({ balanceCents: () => `balance_cents - ${input.amountCents}` })
      .where('user_id = :userId AND status = :status AND balance_cents >= :amount', {
        userId: input.userId,
        status: WalletStatus.NORMAL,
        amount: input.amountCents,
      })
      .execute();

    if (Number(updated.affected ?? 0) === 0) {
      const wallet = await manager.findOne(WalletEntity, { where: { userId: input.userId } });
      if (!wallet) throw new BizException(ErrorCode.INTERNAL_ERROR, '钱包不存在');
      if (wallet.status === WalletStatus.FROZEN) throw new BizException(ErrorCode.WALLET_FROZEN);
      throw new BizException(ErrorCode.INSUFFICIENT_BALANCE, undefined, { balance: Number(wallet.balanceCents) });
    }

    const wallet = await manager.findOneOrFail(WalletEntity, { where: { userId: input.userId } });
    const txn = await this.insertTransaction(manager, {
      userId: input.userId,
      type: TransactionType.DEDUCT,
      amountCents: input.amountCents,
      balanceAfter: wallet.balanceCents,
      billNo: input.billNo,
      productCode: input.productCode,
      detail: input.detail ?? null,
    });

    return { balanceAfter: wallet.balanceCents, transactionId: txn.id, idempotentRepeated: false };
  }

  /** 退款（契约 §4.2）：原单必须已入账；累计退款不得超过原单金额。userId 可省略（从原单反查） */
  async refund(input: {
    userId?: string;
    billNo: string;
    refundBillNo: string;
    amountCents: number;
    reason?: string | null;
    /**
     * 调用方产品身份（来自 X-Internal-Key 的归属）。传入时会校验原账单是否属于该产品：
     * **产品只能用自己密钥退自己的账单**，否则 1004。
     * 门户内部调用（如订单失败自动退款）不传，跳过该校验。
     */
    callerProductCode?: string;
  }): Promise<RefundResult> {
    if (input.amountCents <= 0) {
      throw new BizException(ErrorCode.PARAM_INVALID, 'amount_cents 必须大于 0');
    }

    const existing = await this.findByBillNo(input.refundBillNo);
    if (existing) {
      return {
        balanceAfter: existing.balanceAfter,
        transactionId: existing.id,
        idempotentRepeated: true,
      };
    }

    return this.transactions.manager.transaction(async (manager) => {
      const origin = await manager.findOne(TransactionEntity, {
        where: { billNo: input.billNo, type: TransactionType.DEDUCT },
      });
      if (!origin) throw new BizException(ErrorCode.ORIGIN_BILL_NOT_FOUND);

      // 归属校验：产品 A 的密钥不得退掉产品 B 的账单。
      // productCode 为 NULL 的是门户内部流水（充值/调账），不受产品身份约束。
      if (input.callerProductCode && origin.productCode !== null && origin.productCode !== input.callerProductCode) {
        throw new BizException(
          ErrorCode.FORBIDDEN,
          `该账单属于 ${origin.productCode}，当前密钥（${input.callerProductCode}）无权退款`,
        );
      }

      // 退款退回原扣费的那张钱包；调用方传了 userId 也只作参考，防止退错人
      const userId = origin.userId;

      // 已退金额 = 该原单下所有退款流水之和
      const refunded = await manager
        .createQueryBuilder(TransactionEntity, 't')
        .select('COALESCE(SUM(t.amount_cents), 0)', 'sum')
        .where('t.refund_of_bill_no = :billNo', { billNo: input.billNo })
        .getRawOne<{ sum: string }>();
      const alreadyRefunded = Number(refunded?.sum ?? 0);
      const originAmount = Number(origin.amountCents);
      if (alreadyRefunded + input.amountCents > originAmount) {
        throw new BizException(ErrorCode.REFUND_EXCEEDS_ORIGINAL, undefined, {
          origin_amount_cents: originAmount,
          refunded_cents: alreadyRefunded,
          refundable_cents: originAmount - alreadyRefunded,
        });
      }

      const wallet = await manager.findOne(WalletEntity, {
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!wallet) throw new BizException(ErrorCode.INTERNAL_ERROR, '钱包不存在');

      await manager
        .createQueryBuilder()
        .update(WalletEntity)
        .set({ balanceCents: () => `balance_cents + ${input.amountCents}` })
        .where('user_id = :userId', { userId })
        .execute();

      const after = await manager.findOneOrFail(WalletEntity, { where: { userId } });
      const txn = await this.insertTransaction(manager, {
        userId,
        type: TransactionType.REFUND,
        amountCents: input.amountCents,
        balanceAfter: after.balanceCents,
        billNo: input.refundBillNo,
        refundOfBillNo: input.billNo,
        productCode: origin.productCode,
        detail: input.reason ? { reason: input.reason } : null,
      });

      return { balanceAfter: after.balanceCents, transactionId: txn.id, idempotentRepeated: false };
    });
  }

  /** 入金（充值核销 / 人工调账）；billNo 为幂等键 */
  async credit(input: {
    userId: string;
    billNo: string;
    amountCents: number;
    type: TransactionType.RECHARGE | TransactionType.ADJUST;
    detail?: Record<string, unknown> | null;
  }): Promise<{ balanceAfter: string; transactionId: string; idempotentRepeated: boolean }> {
    if (input.amountCents <= 0) {
      throw new BizException(ErrorCode.PARAM_INVALID, '金额必须大于 0');
    }

    const existing = await this.findByBillNo(input.billNo);
    if (existing) {
      return { balanceAfter: existing.balanceAfter, transactionId: existing.id, idempotentRepeated: true };
    }

    return this.transactions.manager.transaction(async (manager) => {
      await manager.findOneOrFail(WalletEntity, {
        where: { userId: input.userId },
        lock: { mode: 'pessimistic_write' },
      });

      await manager
        .createQueryBuilder()
        .update(WalletEntity)
        .set({ balanceCents: () => `balance_cents + ${input.amountCents}` })
        .where('user_id = :userId', { userId: input.userId })
        .execute();

      const after = await manager.findOneOrFail(WalletEntity, { where: { userId: input.userId } });
      const txn = await this.insertTransaction(manager, {
        userId: input.userId,
        type: input.type,
        amountCents: input.amountCents,
        balanceAfter: after.balanceCents,
        billNo: input.billNo,
        productCode: null,
        detail: input.detail ?? null,
      });

      return { balanceAfter: after.balanceCents, transactionId: txn.id, idempotentRepeated: false };
    });
  }

  /** 按幂等键查流水（内网退款接口用它定位原单归属） */
  async findTransactionByBillNo(billNo: string): Promise<TransactionEntity | null> {
    return this.transactions.findOne({ where: { billNo } });
  }

  private async findByBillNo(billNo: string): Promise<TransactionEntity | null> {
    return this.findTransactionByBillNo(billNo);
  }

  private async insertTransaction(
    manager: EntityManager,
    input: {
      userId: string;
      type: TransactionType;
      amountCents: number;
      balanceAfter: string;
      billNo: string;
      refundOfBillNo?: string | null;
      productCode: string | null;
      detail: Record<string, unknown> | null;
    },
  ): Promise<TransactionEntity> {
    const entity = manager.create(TransactionEntity, {
      userId: input.userId,
      type: input.type,
      amountCents: String(input.amountCents),
      balanceAfter: input.balanceAfter,
      billNo: input.billNo,
      refundOfBillNo: input.refundOfBillNo ?? null,
      productCode: input.productCode,
      detail: input.detail,
    });
    return manager.save(TransactionEntity, entity);
  }
}
