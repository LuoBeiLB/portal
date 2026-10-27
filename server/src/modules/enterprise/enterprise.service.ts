import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';

import { BizException, ErrorCode } from '../../common/error/error-code';
import { uuidv7 } from '../../common/util/crypto.util';
import { PasswordService } from '../auth/password.service';
import { TokenService } from '../auth/token.service';
import { UserRole, UserStatus, UserType } from '../user/entities/user-status.enum';
import { UserEntity } from '../user/entities/user.entity';
import { WalletEntity } from '../wallet/entities/wallet.entity';
import {
  CreateEnterpriseDto,
  CreateEnterpriseUserDto,
  EnterpriseQueryDto,
  EnterpriseUserQueryDto,
  RegisterEnterpriseDto,
} from './dto/enterprise.dto';
import {
  EnterpriseListView,
  EnterpriseRegisteredView,
  EnterpriseReviewView,
  EnterpriseUserCreatedView,
  EnterpriseUserListView,
  EnterpriseUserPasswordResetView,
  EnterpriseUserView,
  EnterpriseView,
  OwnerAssignedView,
} from './dto/enterprise.vo';
import { EnterpriseEntity, EnterpriseRole, EnterpriseStatus } from './entities/enterprise.entity';

/** 初始密码字符集：去掉 0/O/1/l/I 这类易混字符，方便口头或短信转达 */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PASSWORD_SYMBOLS = '!@#$%';

/**
 * 企业（租户根）、注册审核、企业管理员角色。
 *
 * 职责边界（见 `docs/22` §6.1）：**门户管账号/归属/性质/注册审核；
 * 云存储管部门/角色/数据权限/资源**。本服务不碰任何产品概念。
 */
@Injectable()
export class EnterpriseService {
  constructor(
    @InjectRepository(EnterpriseEntity) private readonly enterprises: Repository<EnterpriseEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly dataSource: DataSource,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  /* ============================================================
     企业自助注册（主路径，docs/23 图①）
     ============================================================ */

  /**
   * C 端自助注册企业（**免登录**）。
   *
   * 一个事务做三件事，缺一不可：建企业(`pending`) → 建企业管理员账号
   * (`user_type=1` + `enterprise_role=1`) → 回填 `owner_user_id`。
   *
   * 为什么账号必须和注册绑在一起：v2 之前是"先有个人账号再开通企业"，
   * 那会带出"个人余额怎么处理"的一堆问题（企业员工不能自助消费）。
   * 注册即建号就没这个问题。
   */
  async register(dto: RegisterEnterpriseDto): Promise<EnterpriseRegisteredView> {
    const code = dto.code.trim();
    const username = dto.admin_username.trim();

    if (await this.enterprises.findOne({ where: { code } })) {
      throw new BizException(ErrorCode.ENTERPRISE_CODE_EXISTS);
    }
    // 企业管理员账号与 C 端个人用户**共用命名空间**，全库唯一
    if (await this.users.findOne({ where: { username } })) {
      throw new BizException(ErrorCode.ENTERPRISE_ADMIN_USERNAME_TAKEN);
    }

    const passwordHash = await this.password.hash(dto.admin_password);
    const adminUserId = uuidv7();

    const created = await this.dataSource.transaction(async (manager) => {
      const enterprise = await manager.save(
        EnterpriseEntity,
        manager.create(EnterpriseEntity, {
          code,
          name: dto.name.trim(),
          contactName: dto.contact_name?.trim() ?? null,
          contactPhone: dto.contact_phone?.trim() ?? null,
          remark: dto.remark?.trim() ?? null,
          status: EnterpriseStatus.PENDING,
          ownerUserId: null,
          expireAt: null,
        }),
      );
      const enterpriseId = String(enterprise.id);

      const admin = await manager.save(
        UserEntity,
        manager.create(UserEntity, {
          id: adminUserId,
          username,
          phone: dto.contact_phone?.trim() || null,
          passwordHash,
          role: UserRole.USER,
          userType: UserType.ENTERPRISE_STAFF,
          enterpriseId,
          enterpriseRole: EnterpriseRole.ADMIN,
          status: UserStatus.NORMAL,
          // 密码是他自己设的，不需要首登改密
          mustChangePassword: 0,
        }),
      );
      await manager.save(WalletEntity, manager.create(WalletEntity, { userId: admin.id }));
      await manager.update(EnterpriseEntity, { id: enterpriseId }, { ownerUserId: admin.id });

      return { enterpriseId, username: admin.username };
    });

    return {
      enterprise_id: created.enterpriseId,
      status: EnterpriseStatus.PENDING,
      admin_username: created.username,
      message: '注册已提交，等待平台审核',
    };
  }

  /* ============================================================
     平台审核（docs/23 图① 后半段）
     ============================================================ */

  /** 审核通过：`pending` / `rejected`（重新通过）→ `active` */
  async approve(enterpriseId: string, reviewerId: string): Promise<EnterpriseReviewView> {
    const enterprise = await this.requireEnterprise(enterpriseId);
    if (enterprise.status !== EnterpriseStatus.PENDING && enterprise.status !== EnterpriseStatus.REJECTED) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `企业当前状态是 ${enterprise.status}，只有 pending / rejected 可以审核`,
      );
    }

    await this.enterprises.update(
      { id: enterpriseId },
      { status: EnterpriseStatus.ACTIVE, reviewedAt: new Date(), reviewedBy: reviewerId, rejectReason: null },
    );
    await this.revokeAllMembers(enterpriseId);

    return { ok: true, enterprise_id: String(enterpriseId), status: EnterpriseStatus.ACTIVE };
  }

  /** 审核驳回：`pending` → `rejected`，**原因必填**（登录时回显） */
  async reject(enterpriseId: string, reviewerId: string, reason?: string): Promise<EnterpriseReviewView> {
    const trimmed = reason?.trim();
    if (!trimmed) throw new BizException(ErrorCode.PARAM_INVALID, '驳回必须填写原因');

    const enterprise = await this.requireEnterprise(enterpriseId);
    if (enterprise.status !== EnterpriseStatus.PENDING) {
      throw new BizException(ErrorCode.PARAM_INVALID, `企业当前状态是 ${enterprise.status}，只有 pending 可以驳回`);
    }

    await this.enterprises.update(
      { id: enterpriseId },
      {
        status: EnterpriseStatus.REJECTED,
        reviewedAt: new Date(),
        reviewedBy: reviewerId,
        rejectReason: trimmed.slice(0, 255),
      },
    );
    await this.revokeAllMembers(enterpriseId);

    return { ok: true, enterprise_id: String(enterpriseId), status: EnterpriseStatus.REJECTED };
  }

  /** 停用 / 恢复企业（运营动作，客户不能自助） */
  async setStatus(enterpriseId: string, status: EnterpriseStatus): Promise<EnterpriseReviewView> {
    const enterprise = await this.requireEnterprise(enterpriseId);
    if (status === EnterpriseStatus.ACTIVE && enterprise.status === EnterpriseStatus.PENDING) {
      throw new BizException(ErrorCode.PARAM_INVALID, '待审核的企业请走审核通过，不要直接激活');
    }
    await this.enterprises.update({ id: enterpriseId }, { status });
    await this.revokeAllMembers(enterpriseId);
    return { ok: true, enterprise_id: String(enterpriseId), status };
  }

  /* ============================================================
     管理端：列表 / 代客建企业 / 指定主管理员
     ============================================================ */

  async listEnterprises(query: EnterpriseQueryDto): Promise<EnterpriseListView> {
    const page = query.page ?? 1;
    const size = query.size ?? 20;

    const qb = this.enterprises.createQueryBuilder('e');
    if (query.status) qb.andWhere('e.status = :status', { status: query.status });
    if (query.keyword) {
      qb.andWhere('(e.code LIKE :kw OR e.name LIKE :kw)', { kw: `%${query.keyword.trim()}%` });
    }
    qb.orderBy('e.id', 'DESC')
      .skip((page - 1) * size)
      .take(size);

    const [rows, total] = await qb.getManyAndCount();

    /* 成员数一次算出来，避免审核页 N+1 */
    const ids = rows.map((r) => String(r.id));
    const counts = new Map<string, number>();
    if (ids.length) {
      const raw = (await this.users
        .createQueryBuilder('u')
        .select('u.enterprise_id', 'eid')
        .addSelect('COUNT(*)', 'cnt')
        .where('u.enterprise_id IN (:...ids)', { ids })
        .groupBy('u.enterprise_id')
        .getRawMany()) as Array<{ eid: string; cnt: string }>;
      raw.forEach((r) => counts.set(String(r.eid), Number(r.cnt)));
    }

    /* 审核人用户名，一次查出来 */
    const reviewerIds = [...new Set(rows.map((r) => r.reviewedBy).filter((x): x is string => Boolean(x)))];
    const reviewers = new Map<string, string>();
    if (reviewerIds.length) {
      const list = await this.users.find({ where: { id: In(reviewerIds) } });
      list.forEach((u) => reviewers.set(u.id, u.username));
    }

    return {
      total,
      page,
      size,
      list: rows.map((r) =>
        this.toView(r, counts.get(String(r.id)) ?? 0, r.reviewedBy ? reviewers.get(r.reviewedBy) ?? null : null),
      ),
    };
  }

  /** 代客建企业（后台兜底，前端不给入口）：只写 enterprise，`pending` */
  async createEnterprise(dto: CreateEnterpriseDto, operatorId: string): Promise<EnterpriseView> {
    const code = dto.code.trim();
    if (await this.enterprises.findOne({ where: { code } })) {
      throw new BizException(ErrorCode.ENTERPRISE_CODE_EXISTS);
    }

    const entity = this.enterprises.create({
      code,
      name: dto.name.trim(),
      contactName: dto.contact_name?.trim() ?? null,
      contactPhone: dto.contact_phone?.trim() ?? null,
      remark: dto.remark?.trim() ?? null,
      status: EnterpriseStatus.PENDING,
      ownerUserId: null,
      expireAt: dto.expire_at ? new Date(dto.expire_at) : null,
    });
    const saved = await this.enterprises.save(entity);
    const fresh = await this.enterprises.findOneOrFail({ where: { id: saved.id } });
    void operatorId;
    return this.toView(fresh, 0, null);
  }

  /**
   * 指定 / 移交主管理员（运营介入时用，正常走注册）。
   *
   * v2 之后这里多一件事：**同时把 `enterprise_role` 置 1**，
   * 否则"判权看 enterprise_role"与"谁是 owner"会不一致。
   */
  async assignOwner(enterpriseId: string, targetUserId: string, operatorId: string): Promise<OwnerAssignedView> {
    const enterprise = await this.requireEnterprise(enterpriseId);
    const target = await this.users.findOne({ where: { id: targetUserId } });
    if (!target) throw new BizException(ErrorCode.PARAM_INVALID, '目标账号不存在');
    if (target.role === UserRole.ADMIN) {
      throw new BizException(ErrorCode.PARAM_INVALID, '平台管理员不能作为企业管理员');
    }
    if (target.status === UserStatus.DISABLED) {
      throw new BizException(ErrorCode.PARAM_INVALID, '目标账号已被禁用');
    }
    if (target.enterpriseId && String(target.enterpriseId) !== String(enterpriseId)) {
      throw new BizException(ErrorCode.USER_ALREADY_IN_ENTERPRISE, '该账号已属于其他企业');
    }

    const previousOwner = enterprise.ownerUserId ? String(enterprise.ownerUserId) : null;
    const transferred = previousOwner !== null && previousOwner !== target.id;

    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        UserEntity,
        { id: target.id },
        {
          userType: UserType.ENTERPRISE_STAFF,
          enterpriseId: String(enterpriseId),
          enterpriseRole: EnterpriseRole.ADMIN,
        },
      );

      const patch: Partial<EnterpriseEntity> = { ownerUserId: target.id };
      if (enterprise.status === EnterpriseStatus.PENDING) patch.status = EnterpriseStatus.ACTIVE;
      await manager.update(EnterpriseEntity, { id: enterpriseId }, patch);

      /* 旧主管理员降回普通成员（一期只有一个企业管理员） */
      if (previousOwner && previousOwner !== target.id) {
        await manager.update(UserEntity, { id: previousOwner }, { enterpriseRole: EnterpriseRole.MEMBER });
      }
    });

    const revoked = previousOwner ? await this.tokens.revokeAllSessions(previousOwner) : 0;
    void operatorId;

    return {
      ok: true,
      enterprise_id: String(enterpriseId),
      status: enterprise.status === EnterpriseStatus.PENDING ? EnterpriseStatus.ACTIVE : enterprise.status,
      owner_user_id: target.id,
      transferred,
      revoked_sessions: revoked,
    };
  }

  /** 管理端把已有账号分配 / 调整到某企业（作为普通成员） */
  async assignUserToEnterprise(targetUserId: string, enterpriseId: string): Promise<EnterpriseUserView> {
    const enterprise = await this.requireEnterprise(enterpriseId);
    if (enterprise.status !== EnterpriseStatus.ACTIVE) {
      throw new BizException(ErrorCode.ENTERPRISE_UNAVAILABLE, '企业未激活，不能分配账号');
    }

    const target = await this.users.findOne({ where: { id: targetUserId } });
    if (!target) throw new BizException(ErrorCode.PARAM_INVALID, '目标账号不存在');
    if (target.role === UserRole.ADMIN) {
      throw new BizException(ErrorCode.PARAM_INVALID, '平台管理员不能归属企业');
    }
    if (target.enterpriseId && String(target.enterpriseId) !== String(enterpriseId)) {
      throw new BizException(ErrorCode.USER_ALREADY_IN_ENTERPRISE);
    }

    await this.users.update(
      { id: target.id },
      {
        userType: UserType.ENTERPRISE_STAFF,
        enterpriseId: String(enterpriseId),
        enterpriseRole: target.enterpriseRole ?? EnterpriseRole.MEMBER,
      },
    );
    await this.tokens.revokeAllSessions(target.id);

    const fresh = await this.users.findOneOrFail({ where: { id: target.id } });
    return this.toUserView(fresh, enterprise);
  }

  /* ============================================================
     企业端（企业管理员）
     ============================================================ */

  async listEnterpriseUsers(enterpriseId: string, query: EnterpriseUserQueryDto): Promise<EnterpriseUserListView> {
    const page = query.page ?? 1;
    const size = query.size ?? 20;
    const enterprise = await this.enterprises.findOne({ where: { id: enterpriseId } });

    const qb = this.users.createQueryBuilder('u');
    qb.where('u.enterprise_id = :eid', { eid: enterpriseId });
    if (query.keyword) {
      qb.andWhere('(u.username LIKE :kw OR u.phone LIKE :kw)', { kw: `%${query.keyword.trim()}%` });
    }
    qb.orderBy('u.created_at', 'DESC')
      .addOrderBy('u.id', 'DESC')
      .skip((page - 1) * size)
      .take(size);

    const [rows, total] = await qb.getManyAndCount();
    return { total, page, size, list: rows.map((u) => this.toUserView(u, enterprise ?? null)) };
  }

  /**
   * 企业管理员建本企业员工。
   *
   * ⚠️ `enterpriseId` 由 controller 从**登录态**传入，不接受请求体 ——
   * 否则企业管理员能把员工建到别家企业，整套改动里最隐蔽的越权点。
   */
  async createEnterpriseUser(
    enterpriseId: string,
    dto: CreateEnterpriseUserDto,
  ): Promise<EnterpriseUserCreatedView> {
    const username = dto.username.trim();
    if (await this.users.findOne({ where: { username } })) throw new BizException(ErrorCode.USERNAME_EXISTS);
    if (dto.phone && (await this.users.findOne({ where: { phone: dto.phone } }))) {
      throw new BizException(ErrorCode.PHONE_REGISTERED);
    }

    const initialPassword = generateInitialPassword();
    const passwordHash = await this.password.hash(initialPassword);

    await this.dataSource.transaction(async (manager) => {
      const user = manager.create(UserEntity, {
        id: uuidv7(),
        username,
        phone: dto.phone ?? null,
        passwordHash,
        role: UserRole.USER,
        userType: UserType.ENTERPRISE_STAFF,
        enterpriseId: String(enterpriseId),
        enterpriseRole: EnterpriseRole.MEMBER,
        status: UserStatus.NORMAL,
        mustChangePassword: 1,
      });
      const saved = await manager.save(UserEntity, user);
      await manager.save(WalletEntity, manager.create(WalletEntity, { userId: saved.id }));
    });

    const created = await this.users.findOneOrFail({ where: { username } });
    return {
      id: created.id,
      username: created.username,
      enterprise_id: String(enterpriseId),
      initial_password: initialPassword,
      must_change_password: true,
    };
  }

  async resetEnterpriseUserPassword(
    enterpriseId: string,
    targetUserId: string,
  ): Promise<EnterpriseUserPasswordResetView> {
    const target = await this.requireSameEnterprise(enterpriseId, targetUserId);
    const initialPassword = generateInitialPassword();
    const passwordHash = await this.password.hash(initialPassword);

    await this.users.update({ id: target.id }, { passwordHash, mustChangePassword: 1 });
    const revoked = await this.tokens.revokeAllSessions(target.id);

    return { ok: true, initial_password: initialPassword, must_change_password: true, revoked_sessions: revoked };
  }

  async setEnterpriseUserStatus(
    enterpriseId: string,
    targetUserId: string,
    status: number,
  ): Promise<{ ok: true; status: number; revoked_sessions: number; is_owner: boolean }> {
    const target = await this.requireSameEnterprise(enterpriseId, targetUserId);

    /*
     * 主管理员不能被停用 —— 否则企业无人可管，而 owner_user_id 又不能指向停用账号。
     * 判据用 owner_user_id（资源持有人/付费方），不是 enterprise_role：
     * 其他企业管理员可以停，主管理员不行。
     */
    const isOwner = await this.isPrimaryAdmin(enterpriseId, target.id);
    if (isOwner && status === UserStatus.DISABLED) {
      throw new BizException(ErrorCode.PARAM_INVALID, '主管理员不能被停用，请先移交再停用');
    }

    await this.users.update({ id: target.id }, { status });
    const revoked = status === UserStatus.DISABLED ? await this.tokens.revokeAllSessions(target.id) : 0;

    return { ok: true, status, revoked_sessions: revoked, is_owner: isOwner };
  }

  /* ============================================================
     供 auth / console 复用
     ============================================================ */

  async requireEnterprise(enterpriseId: string): Promise<EnterpriseEntity> {
    const enterprise = await this.enterprises.findOne({ where: { id: enterpriseId } });
    if (!enterprise) throw new BizException(ErrorCode.ENTERPRISE_UNAVAILABLE, '企业不存在');
    return enterprise;
  }

  async findEnterprise(enterpriseId: string): Promise<EnterpriseEntity | null> {
    return this.enterprises.findOne({ where: { id: enterpriseId } });
  }

  async findActiveEnterprise(enterpriseId: string): Promise<EnterpriseEntity | null> {
    const found = await this.enterprises.find({ where: { id: enterpriseId, status: EnterpriseStatus.ACTIVE } });
    return found.length ? (found[0] ?? null) : null;
  }

  async findEnterprisesByIds(ids: string[]): Promise<EnterpriseEntity[]> {
    if (!ids.length) return [];
    return this.enterprises.find({ where: { id: In(ids) } });
  }

  /** 该账号是不是本企业的**主管理员**（`owner_user_id` 指向他） */
  async isPrimaryAdmin(enterpriseId: string, userId: string): Promise<boolean> {
    const enterprise = await this.enterprises.findOne({ where: { id: enterpriseId } });
    return Boolean(enterprise?.ownerUserId && String(enterprise.ownerUserId) === userId);
  }

  async countMembers(enterpriseId: string): Promise<number> {
    return this.users.count({ where: { enterpriseId } });
  }

  /* ============================================================
     内部工具
     ============================================================ */

  private async requireSameEnterprise(enterpriseId: string, targetUserId: string): Promise<UserEntity> {
    const target = await this.users.findOne({ where: { id: targetUserId } });
    if (!target || !target.enterpriseId || String(target.enterpriseId) !== String(enterpriseId)) {
      throw new BizException(ErrorCode.PARAM_INVALID, '该账号不属于本企业');
    }
    return target;
  }

  /** 企业状态变化后，让该企业全部成员的 token 判断失效 */
  private async revokeAllMembers(enterpriseId: string): Promise<void> {
    const members = await this.users.find({ where: { enterpriseId }, select: ['id'] });
    await Promise.all(members.map((m) => this.tokens.revokeAllSessions(m.id)));
  }

  private toView(e: EnterpriseEntity, memberCount: number, reviewedByUsername: string | null): EnterpriseView {
    return {
      id: String(e.id),
      code: e.code,
      name: e.name,
      status: e.status,
      contact_name: e.contactName,
      contact_phone: e.contactPhone,
      remark: e.remark,
      owner_user_id: e.ownerUserId ? String(e.ownerUserId) : null,
      expire_at: e.expireAt ? isoSeconds(e.expireAt) : null,
      reviewed_at: e.reviewedAt ? isoSeconds(e.reviewedAt) : null,
      reviewed_by: e.reviewedBy ? String(e.reviewedBy) : null,
      reviewed_by_username: reviewedByUsername,
      reject_reason: e.rejectReason,
      member_count: memberCount,
      created_at: isoSeconds(e.createdAt),
    };
  }

  private toUserView(u: UserEntity, enterprise: EnterpriseEntity | null): EnterpriseUserView {
    return {
      id: u.id,
      username: u.username,
      phone: u.phone,
      status: u.status,
      is_owner: Boolean(enterprise?.ownerUserId && String(enterprise.ownerUserId) === u.id),
      is_admin: u.enterpriseRole === EnterpriseRole.ADMIN,
      must_change_password: u.mustChangePassword === 1,
      created_at: isoSeconds(u.createdAt),
    };
  }
}

/* ────────────────────────── 工具 ────────────────────────── */

/** UTC ISO 8601，去掉毫秒（与既有响应口径一致） */
function isoSeconds(value: Date | string): string {
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 生成初始密码：12 位，必含大小写、数字、符号各一。
 *
 * 用 `crypto.randomInt` 而非 `Math.random`：初始密码是真实凭据，不能用可预测的伪随机。
 */
export function generateInitialPassword(): string {
  const pick = (set: string): string => set[randomInt(0, set.length)] as string;
  const chars = [
    pick('abcdefghjkmnpqrstuvwxyz'),
    pick('ABCDEFGHJKMNPQRSTUVWXYZ'),
    pick('23456789'),
    pick(PASSWORD_SYMBOLS),
    ...Array.from({ length: 8 }, () => pick(PASSWORD_ALPHABET)),
  ];
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}
