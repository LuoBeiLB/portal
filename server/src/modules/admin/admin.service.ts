import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { uuidv7 } from '../../common/crypto.util';
import { BizException, ErrorCode } from '../../common/error-code';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { UserRole, UserStatus, WalletStatus } from '../user/entities/user-status.enum';
import { UserEntity } from '../user/entities/user.entity';
import { TransactionEntity } from '../wallet/entities/transaction.entity';
import { WalletEntity } from '../wallet/entities/wallet.entity';
import { toIsoUtc } from '../audit/audit.service';

export interface AdminUserView {
  id: string;
  username: string;
  phone: string | null;
  balance_cents: number;
  status: number;
  role: string;
  created_at: string | null;
  /** 累计充值（type=1 之和）与累计消费（type=2 之和） */
  recharge_total_cents: number;
  consume_total_cents: number;
}

export interface AdminTransactionView {
  id: string;
  user_id: string;
  username: string | null;
  type: number;
  amount_cents: number;
  balance_after: number;
  product_code: string | null;
  bill_no: string;
  refund_of_bill_no: string | null;
  detail: Record<string, unknown> | null;
  created_at: string | null;
  /** 该用户当前余额（核销/排查时一眼看到） */
  user_balance_cents: number | null;
}

/**
 * 管理端查询与账号管理（2026-10-10 新增，对应前端《管理端-缺失接口需求清单》）。
 *
 * 为什么单独建模块而不是塞进 WalletService：这里要跨 `u_user` / `w_wallet` /
 * `w_transaction` / `a_audit_log` 四张表做管理视角的查询与聚合，
 * 塞进钱包服务会让它同时承担"用户端钱包"和"管理端运营后台"两种职责。
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(WalletEntity) private readonly wallets: Repository<WalletEntity>,
    @InjectRepository(TransactionEntity) private readonly transactions: Repository<TransactionEntity>,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly dataSource: DataSource,
  ) {}

  // ───────────────────────── 用户管理 ─────────────────────────

  /** 用户查询列表：**只列 role='user'**，管理员走管理员接口，避免误禁用管理员 */
  async listUsers(filter: {
    page: number;
    size: number;
    keyword?: string;
    status?: number;
  }): Promise<{ list: AdminUserView[]; total: number; page: number; size: number }> {
    const qb = this.users
      .createQueryBuilder('u')
      .where('u.role = :role', { role: UserRole.USER })
      .orderBy('u.created_at', 'DESC')
      .skip((filter.page - 1) * filter.size)
      .take(filter.size);

    if (filter.keyword) {
      qb.andWhere('(u.username LIKE :kw OR u.phone LIKE :kw)', { kw: `%${filter.keyword}%` });
    }
    if (filter.status !== undefined) qb.andWhere('u.status = :status', { status: filter.status });

    const [rows, total] = await qb.getManyAndCount();
    const ids = rows.map((row) => row.id);
    const aggregates = await this.aggregateByUser(ids);

    return {
      list: rows.map((row) => {
        const agg = aggregates.get(row.id);
        return {
          id: row.id,
          username: row.username,
          phone: row.phone,
          balance_cents: agg?.balance_cents ?? 0,
          status: row.status,
          role: row.role,
          created_at: toIsoUtc(row.createdAt),
          recharge_total_cents: agg?.recharge_total_cents ?? 0,
          consume_total_cents: agg?.consume_total_cents ?? 0,
        };
      }),
      total,
      page: filter.page,
      size: filter.size,
    };
  }

  /**
   * 启用/禁用普通用户（前端把 disable/enable 合并成一个状态接口）。
   *
   * 禁用要做三件事（契约 §6）：置 status、**冻结钱包**、**吊销全部 refresh**（强制下线）。
   * 恢复只做两件：置 status、解冻钱包 —— **不恢复登录态**，需用户重新登录。
   */
  async setUserStatus(
    userId: string,
    status: number,
    _reason: string | undefined,
  ): Promise<{ ok: true; status: number }> {
    const user = await this.users.findOne({ where: { id: userId } });
    if (!user) throw new BizException(ErrorCode.ORDER_NOT_FOUND, '用户不存在');

    if (user.role === UserRole.ADMIN) {
      throw new BizException(
        ErrorCode.FORBIDDEN,
        '该账号是管理员，请使用管理员管理接口（/api/admin/admins/{id}/status）',
      );
    }

    const target = status === UserStatus.DISABLED ? UserStatus.DISABLED : UserStatus.NORMAL;
    if (user.status === target) {
      throw new BizException(
        ErrorCode.ORDER_STATUS_NOT_ALLOWED,
        target === UserStatus.DISABLED ? '该用户已是禁用状态' : '该用户已是正常状态',
      );
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(UserEntity, { id: userId }, { status: target, updatedAt: new Date() });
      await manager.update(
        WalletEntity,
        { userId },
        { status: target === UserStatus.DISABLED ? WalletStatus.FROZEN : WalletStatus.NORMAL, updatedAt: new Date() },
      );
    });

    // 禁用必须强制下线；恢复则不动登录态（用户需重新登录）
    if (target === UserStatus.DISABLED) {
      const revoked = await this.tokens.revokeAllSessions(userId);
      this.logger.log(`已禁用用户 ${user.username}（${userId}），吊销 ${revoked} 个 refresh 会话`);
    }

    return { ok: true, status: target };
  }

  /** 聚合每个用户的余额 / 累计充值 / 累计消费（一次查完，避免 N+1） */
  private async aggregateByUser(
    userIds: string[],
  ): Promise<Map<string, { balance_cents: number; recharge_total_cents: number; consume_total_cents: number }>> {
    const result = new Map<
      string,
      { balance_cents: number; recharge_total_cents: number; consume_total_cents: number }
    >();
    if (userIds.length === 0) return result;

    const placeholders = userIds.map(() => '?').join(',');

    const wallets = await this.dataSource.query<Array<{ user_id: string; balance_cents: string }>>(
      `SELECT user_id, balance_cents FROM w_wallet WHERE user_id IN (${placeholders})`,
      userIds,
    );
    for (const row of wallets) {
      result.set(row.user_id, {
        balance_cents: Number(row.balance_cents),
        recharge_total_cents: 0,
        consume_total_cents: 0,
      });
    }

    const sums = await this.dataSource.query<Array<{ user_id: string; type: number; total: string }>>(
      `SELECT user_id, type, COALESCE(SUM(amount_cents), 0) AS total
         FROM w_transaction WHERE user_id IN (${placeholders}) AND type IN (1, 2)
        GROUP BY user_id, type`,
      userIds,
    );
    for (const row of sums) {
      const entry = result.get(row.user_id) ?? { balance_cents: 0, recharge_total_cents: 0, consume_total_cents: 0 };
      if (Number(row.type) === 1) entry.recharge_total_cents = Number(row.total);
      if (Number(row.type) === 2) entry.consume_total_cents = Number(row.total);
      result.set(row.user_id, entry);
    }

    return result;
  }

  // ───────────────────────── 流水 ─────────────────────────

  /** 管理端流水列表：比用户端多 `username` 与 `user_balance_cents`，支持日期区间 */
  async listTransactions(filter: {
    page: number;
    size: number;
    type?: number;
    product_code?: string;
    user_id?: string;
    keyword?: string;
    start_date?: string;
    end_date?: string;
  }): Promise<{ list: AdminTransactionView[]; total: number; page: number; size: number }> {
    const qb = this.transactions.createQueryBuilder('t').orderBy('t.id', 'DESC');

    if (filter.type) qb.andWhere('t.type = :type', { type: filter.type });
    if (filter.product_code) qb.andWhere('t.product_code = :pc', { pc: filter.product_code });
    if (filter.user_id) qb.andWhere('t.user_id = :uid', { uid: filter.user_id });
    if (filter.start_date) qb.andWhere('t.created_at >= :start', { start: `${filter.start_date} 00:00:00.000` });
    if (filter.end_date) qb.andWhere('t.created_at <= :end', { end: `${filter.end_date} 23:59:59.999` });

    // keyword 按用户名/手机号先解析出 userId 集合（管理端最常见的是"按人查流水"）
    if (filter.keyword) {
      const matched = await this.dataSource.query<Array<{ id: string }>>(
        'SELECT id FROM u_user WHERE username LIKE ? OR phone LIKE ? LIMIT 500',
        [`%${filter.keyword}%`, `%${filter.keyword}%`],
      );
      if (matched.length === 0) {
        return { list: [], total: 0, page: filter.page, size: filter.size };
      }
      qb.andWhere('t.user_id IN (:...ids)', { ids: matched.map((row) => row.id) });
    }

    const [rows, total] = await qb
      .skip((filter.page - 1) * filter.size)
      .take(filter.size)
      .getManyAndCount();

    const userIds = [...new Set(rows.map((row) => row.userId))];
    const users = await this.userInfoByIds(userIds);

    return {
      list: rows.map((row) => ({
        id: row.id,
        user_id: row.userId,
        username: users.get(row.userId)?.username ?? null,
        type: row.type,
        amount_cents: Number(row.amountCents),
        balance_after: Number(row.balanceAfter),
        product_code: row.productCode,
        bill_no: row.billNo,
        refund_of_bill_no: row.refundOfBillNo,
        detail: row.detail,
        created_at: toIsoUtc(row.createdAt),
        user_balance_cents: users.get(row.userId)?.balance_cents ?? null,
      })),
      total,
      page: filter.page,
      size: filter.size,
    };
  }

  /** 供导出复用：按同样的过滤条件流式取最多 limit 行 */
  async exportTransactions(filter: {
    type?: number;
    product_code?: string;
    start_date?: string;
    end_date?: string;
    limit: number;
  }): Promise<AdminTransactionView[]> {
    const page = await this.listTransactions({
      page: 1,
      size: Math.min(filter.limit, 50_000),
      type: filter.type,
      product_code: filter.product_code,
      start_date: filter.start_date,
      end_date: filter.end_date,
    });
    return page.list;
  }

  private async userInfoByIds(
    userIds: string[],
  ): Promise<Map<string, { username: string; phone: string | null; balance_cents: number }>> {
    const map = new Map<string, { username: string; phone: string | null; balance_cents: number }>();
    if (userIds.length === 0) return map;

    const placeholders = userIds.map(() => '?').join(',');
    const rows = await this.dataSource.query<
      Array<{ id: string; username: string; phone: string | null; balance_cents: string | null }>
    >(
      `SELECT u.id, u.username, u.phone, w.balance_cents
         FROM u_user u LEFT JOIN w_wallet w ON w.user_id = u.id
        WHERE u.id IN (${placeholders})`,
      userIds,
    );
    for (const row of rows) {
      map.set(row.id, {
        username: row.username,
        phone: row.phone,
        balance_cents: Number(row.balance_cents ?? 0),
      });
    }
    return map;
  }

  // ───────────────────────── 管理员账号 ─────────────────────────

  async listAdmins(): Promise<{ list: Array<Record<string, unknown>>; total: number }> {
    const rows = await this.users.find({
      where: { role: UserRole.ADMIN },
      order: { createdAt: 'ASC' },
    });
    return {
      list: rows.map((row) => ({
        id: row.id,
        username: row.username,
        phone: row.phone,
        status: row.status,
        created_at: toIsoUtc(row.createdAt),
      })),
      total: rows.length,
    };
  }

  /** 创建管理员（首个由环境变量 bootstrap 建，这里建后续的） */
  async createAdmin(input: {
    username: string;
    password: string;
    phone?: string;
  }): Promise<{ id: string; username: string }> {
    const exists = await this.users.findOne({ where: { username: input.username } });
    if (exists) throw new BizException(ErrorCode.USERNAME_EXISTS);

    if (input.phone) {
      const phoneExists = await this.users.findOne({ where: { phone: input.phone } });
      if (phoneExists) throw new BizException(ErrorCode.PHONE_REGISTERED);
    }

    const id = uuidv7();
    const passwordHash = await this.passwords.hash(input.password);
    const now = new Date();

    await this.dataSource.transaction(async (manager) => {
      await manager.insert(UserEntity, {
        id,
        username: input.username,
        phone: input.phone ?? null,
        passwordHash,
        role: UserRole.ADMIN,
        status: UserStatus.NORMAL,
        createdAt: now,
        updatedAt: now,
      });
      // 管理员也可能消费（例如自己买存储），建钱包保持与普通用户一致
      await manager.insert(WalletEntity, { userId: id, balanceCents: '0', updatedAt: now });
    });

    return { id, username: input.username };
  }

  /**
   * 启用/禁用管理员。
   *
   * 两道守卫防止把自己锁在门外：
   * 1. **不能禁用最后一个可用管理员**（否则没人能进管理端，只能改库救）；
   * 2. **不能禁用自己**（手滑把当前账号禁掉，会立刻失去权限）。
   */
  async setAdminStatus(
    actorId: string,
    targetId: string,
    status: number,
  ): Promise<{ ok: true; status: number; revoked_sessions: number }> {
    const target = await this.users.findOne({ where: { id: targetId } });
    if (!target || target.role !== UserRole.ADMIN) {
      throw new BizException(ErrorCode.ORDER_NOT_FOUND, '管理员不存在');
    }

    const next = status === UserStatus.DISABLED ? UserStatus.DISABLED : UserStatus.NORMAL;
    if (target.status === next) {
      throw new BizException(
        ErrorCode.ORDER_STATUS_NOT_ALLOWED,
        next === UserStatus.DISABLED ? '该管理员已是禁用状态' : '该管理员已是正常状态',
      );
    }

    if (next === UserStatus.DISABLED) {
      if (targetId === actorId) {
        throw new BizException(ErrorCode.FORBIDDEN, '不能禁用自己的账号');
      }
      const enabledAdmins = await this.users.count({
        where: { role: UserRole.ADMIN, status: UserStatus.NORMAL },
      });
      if (enabledAdmins <= 1) {
        throw new BizException(ErrorCode.FORBIDDEN, '不能禁用最后一个可用的管理员账号');
      }
    }

    await this.users.update({ id: targetId }, { status: next, updatedAt: new Date() });
    const revoked = next === UserStatus.DISABLED ? await this.tokens.revokeAllSessions(targetId) : 0;

    return { ok: true, status: next, revoked_sessions: revoked };
  }

  /** 管理员重置**他人**密码；重置后强制对方重新登录 */
  async resetAdminPassword(
    actorId: string,
    targetId: string,
    newPassword: string,
  ): Promise<{ ok: true; revoked_sessions: number }> {
    const target = await this.users.findOne({ where: { id: targetId } });
    if (!target || target.role !== UserRole.ADMIN) {
      throw new BizException(ErrorCode.ORDER_NOT_FOUND, '管理员不存在');
    }
    if (targetId === actorId) {
      throw new BizException(ErrorCode.PARAM_INVALID, '修改自己的密码请使用 POST /api/auth/password');
    }

    const passwordHash = await this.passwords.hash(newPassword);
    await this.users.update({ id: targetId }, { passwordHash, updatedAt: new Date() });
    const revoked = await this.tokens.revokeAllSessions(targetId);

    return { ok: true, revoked_sessions: revoked };
  }

  /**
   * 环境变量 bootstrap 首个管理员（幂等）。
   *
   * 每次启动都会**校准密码与角色**，所以它也是"密码忘了怎么办"的找回入口。
   * 之所以用环境变量而不是接口：避免出现"部署完到创建首个管理员之间"的时间窗，
   * 那段时间里任何能访问该接口的人都能把自己变成管理员。
   */
  async bootstrapAdmin(username: string, password: string, phone?: string): Promise<'created' | 'updated'> {
    const existing = await this.users.findOne({ where: { username } });
    const passwordHash = await this.passwords.hash(password);
    const now = new Date();

    if (existing) {
      await this.users.update(
        { id: existing.id },
        {
          passwordHash,
          role: UserRole.ADMIN,
          status: UserStatus.NORMAL,
          phone: phone ?? existing.phone,
          updatedAt: now,
        },
      );
      // 保证有钱包（历史数据或手工建的管理员可能没有）
      const wallet = await this.wallets.findOne({ where: { userId: existing.id } });
      if (!wallet) {
        await this.wallets.insert({ userId: existing.id, balanceCents: '0', updatedAt: now });
      }
      return 'updated';
    }

    const id = uuidv7();
    await this.dataSource.transaction(async (manager) => {
      await manager.insert(UserEntity, {
        id,
        username,
        phone: phone ?? null,
        passwordHash,
        role: UserRole.ADMIN,
        status: UserStatus.NORMAL,
        createdAt: now,
        updatedAt: now,
      });
      await manager.insert(WalletEntity, { userId: id, balanceCents: '0', updatedAt: now });
    });
    return 'created';
  }

  /** 校验当前登录态（前端登录页用它替代"随便调个业务接口看 1004"） */
  async verify(operator: { id: string; username: string; role: string }): Promise<{
    ok: true;
    operator: string;
    operator_id: string;
    role: string;
    server_time: string;
  }> {
    return {
      ok: true,
      operator: operator.username,
      operator_id: operator.id,
      role: operator.role,
      server_time: toIsoUtc(new Date()) ?? '',
    };
  }
}
