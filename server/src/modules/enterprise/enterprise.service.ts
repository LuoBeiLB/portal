import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomInt } from 'node:crypto';
import { DataSource, In, Repository } from 'typeorm';

import { BizException, ErrorCode } from '../../common/error/error-code';
import { uuidv7 } from '../../common/util/crypto.util';
import { TokenService } from '../auth/token.service';
import { PasswordService } from '../auth/password.service';
import { UserRole, UserStatus, UserType } from '../user/entities/user-status.enum';
import { UserEntity } from '../user/entities/user.entity';
import { WalletEntity } from '../wallet/entities/wallet.entity';
import { EnterpriseQueryDto, EnterpriseUserQueryDto, CreateEnterpriseUserDto, CreateEnterpriseDto } from './dto/enterprise.dto';
import {
  EnterpriseListView,
  EnterpriseUserCreatedView,
  EnterpriseUserListView,
  EnterpriseUserPasswordResetView,
  EnterpriseUserView,
  EnterpriseView,
  OwnerAssignedView,
} from './dto/enterprise.vo';
import { EnterpriseEntity, EnterpriseStatus } from './entities/enterprise.entity';

/** 初始密码字符集：去掉 0/O/1/l/I 这类易混字符，方便管理员口头或短信转达 */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PASSWORD_SYMBOLS = '!@#$%';

/**
 * 企业（租户根）与账号归属。
 *
 * 职责边界（见 `docs/22` §6、`docs/24` §1.3）：
 *
 * - **门户负责**：账号、企业归属、账号性质、所有者身份
 * - **云存储负责**：部门、角色、数据权限、资源分配
 *
 * 所以本服务**不碰任何产品概念**：不建角色模板、不管部门。角色模板由云存储在
 * 该企业首次被访问时惰性创建（`docs/18` §4.2.1）。
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
     建企业
     ============================================================ */

  /**
   * 建企业（流程①）。**只写 enterprise 一行，状态 `pending`，所有者留空。**
   *
   * 为什么不在这里直接建所有者：所有者必须是本企业员工（`user_type=1` 要求
   * `enterprise_id` 非空），而企业得先有 id —— 所以必须拆两步，见类注释。
   */
  async createEnterprise(dto: CreateEnterpriseDto, operatorId: string): Promise<EnterpriseView> {
    const code = dto.code.trim();
    const exists = await this.enterprises.findOne({ where: { code } });
    if (exists) throw new BizException(ErrorCode.PARAM_INVALID, `企业编码 ${code} 已被占用`);

    const entity = this.enterprises.create({
      code,
      name: dto.name.trim(),
      status: EnterpriseStatus.PENDING,
      quotaBytes: String(dto.quota_bytes ?? 0),
      ownerUserId: null,
      expireAt: dto.expire_at ? new Date(dto.expire_at) : null,
    });
    const saved = await this.enterprises.save(entity);
    /*
     * 回读一次：created_at / updated_at 由库侧 DEFAULT 生成，内存对象里没有
     * （TypeORM 不会自动回填 DB 默认值）。不回读的话返回体里时间是 undefined。
     */
    const fresh = await this.enterprises.findOneOrFail({ where: { id: saved.id } });
    // operatorId 目前只用于审计（由调用方 controller 写），这里不落库
    void operatorId;
    return this.toView(fresh);
  }

  /* ============================================================
     指定 / 移交所有者
     ============================================================ */

  /**
   * 指定或移交企业所有者（流程②）。
   *
   * 四条资格校验（对应 `docs/24` §2.4）：
   *
   * 1. **不能是平台管理员** —— 否则他既绕过企业限制又持平台权限
   * 2. **不能已属于别的企业** —— 一个账号只属于一家
   * 3. 个人账号会被**提升**为企业员工（`user_type` 置 1 + 绑定本企业）
   * 4. 企业已有所有者且不是同一个人 → `2009`，换人必须走移交语义（本方法支持）
   *
   * 首次指定会把企业从 `pending` 置为 `active`；移交时企业本来就在服务中，
   * 状态不变（若之前是 `disabled`，这里**不会**顺手激活——停用是运营动作，
   * 不该被"换个人"这个操作悄悄解除）。
   */
  async assignOwner(enterpriseId: string, targetUserId: string, operatorId: string): Promise<OwnerAssignedView> {
    const enterprise = await this.enterprises.findOne({ where: { id: enterpriseId } });
    if (!enterprise) throw new BizException(ErrorCode.ENTERPRISE_UNAVAILABLE, '企业不存在');

    const target = await this.users.findOne({ where: { id: targetUserId } });
    if (!target) throw new BizException(ErrorCode.PARAM_INVALID, '目标账号不存在');

    if (target.role === UserRole.ADMIN) {
      throw new BizException(ErrorCode.PARAM_INVALID, '平台管理员不能作为企业所有者');
    }
    if (target.status === UserStatus.DISABLED) {
      throw new BizException(ErrorCode.PARAM_INVALID, '目标账号已被禁用，不能作为所有者');
    }
    if (target.enterpriseId && String(target.enterpriseId) !== String(enterpriseId)) {
      throw new BizException(ErrorCode.USER_ALREADY_IN_ENTERPRISE, '该账号已属于其他企业');
    }

    const previousOwner = enterprise.ownerUserId ? String(enterprise.ownerUserId) : null;
    const transferred = previousOwner !== null && previousOwner !== target.id;

    await this.dataSource.transaction(async (manager) => {
      // 1) 目标账号必须是本企业员工
      if (target.userType !== UserType.ENTERPRISE_STAFF || !target.enterpriseId) {
        await manager.update(
          UserEntity,
          { id: target.id },
          { userType: UserType.ENTERPRISE_STAFF, enterpriseId: String(enterpriseId) },
        );
      }

      // 2) 回填所有者 + 首次指定时激活企业
      const patch: Partial<EnterpriseEntity> = { ownerUserId: target.id };
      if (enterprise.status === EnterpriseStatus.PENDING) patch.status = EnterpriseStatus.ACTIVE;
      await manager.update(EnterpriseEntity, { id: enterpriseId }, patch);
    });

    // 换了所有者 → 旧所有者的 token 里还带着"我是所有者"的隐含语义，必须重登
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

  /* ============================================================
     管理端：列表 / 把已有账号分配企业
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
    return { total, page, size, list: rows.map((r) => this.toView(r)) };
  }

  /**
   * 管理端把**已有账号**分配 / 调整到某企业。
   *
   * 与 `assignOwner` 的区别：这里只改归属，不碰所有者。
   */
  async assignUserToEnterprise(targetUserId: string, enterpriseId: string): Promise<EnterpriseUserView> {
    const enterprise = await this.enterprises.findOne({ where: { id: enterpriseId } });
    if (!enterprise) throw new BizException(ErrorCode.ENTERPRISE_UNAVAILABLE, '企业不存在');
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
      { userType: UserType.ENTERPRISE_STAFF, enterpriseId: String(enterpriseId) },
    );
    // 归属变了，token 里的 ent 就是旧的 → 强制重登拿新 token
    await this.tokens.revokeAllSessions(target.id);

    const fresh = await this.users.findOneOrFail({ where: { id: target.id } });
    return this.toUserView(fresh, enterprise);
  }

  /* ============================================================
     企业端（所有者）
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
    return {
      total,
      page,
      size,
      list: rows.map((u) => this.toUserView(u, enterprise ?? null)),
    };
  }

  /**
   * 企业所有者建本企业员工（流程③）。
   *
   * ⚠️ **`enterpriseId` 由调用方（controller）从登录态传入**，不接受请求体。
   * 这是本模块最重要的一条约束：如果改成从 body 取，企业所有者能把员工建到别家企业。
   *
   * 为什么要同时建钱包行：`w_wallet` 与 `u_user` 是 1:1（注册即建）。企业员工虽然
   * 余额恒 0、不能充值，但管理端用户列表会 JOIN 钱包取余额——缺行会让列表出现空值。
   */
  async createEnterpriseUser(
    enterpriseId: string,
    dto: CreateEnterpriseUserDto,
  ): Promise<EnterpriseUserCreatedView> {
    const username = dto.username.trim();

    const dupName = await this.users.findOne({ where: { username } });
    if (dupName) throw new BizException(ErrorCode.USERNAME_EXISTS);
    if (dto.phone) {
      const dupPhone = await this.users.findOne({ where: { phone: dto.phone } });
      if (dupPhone) throw new BizException(ErrorCode.PHONE_REGISTERED);
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

  /** 重置本企业员工密码：换新初始密码 + 强制首登改密 + 踢掉全部会话 */
  async resetEnterpriseUserPassword(
    enterpriseId: string,
    targetUserId: string,
  ): Promise<EnterpriseUserPasswordResetView> {
    const target = await this.requireSameEnterprise(enterpriseId, targetUserId);

    const initialPassword = generateInitialPassword();
    const passwordHash = await this.password.hash(initialPassword);

    await this.users.update({ id: target.id }, { passwordHash, mustChangePassword: 1 });
    const revoked = await this.tokens.revokeAllSessions(target.id);

    return {
      ok: true,
      initial_password: initialPassword,
      must_change_password: true,
      revoked_sessions: revoked,
    };
  }

  /** 企业内停用 / 恢复员工 */
  async setEnterpriseUserStatus(
    enterpriseId: string,
    targetUserId: string,
    status: number,
  ): Promise<{ ok: true; status: number; revoked_sessions: number; is_owner: boolean }> {
    const target = await this.requireSameEnterprise(enterpriseId, targetUserId);
    const enterprise = await this.enterprises.findOne({ where: { id: enterpriseId } });

    /*
     * 所有者不能被停用 —— 否则企业变成"无人可管"，而 owner_user_id 又不能指向
     * 一个停用账号。要停用必须先移交。
     */
    const isOwner = enterprise?.ownerUserId && String(enterprise.ownerUserId) === target.id;
    if (isOwner && status === UserStatus.DISABLED) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        '企业所有者不能被停用，请先移交所有者再停用',
      );
    }

    await this.users.update({ id: target.id }, { status });
    // 禁用要立刻下线；启用不恢复登录态，所以也顺手清一次会话无副作用
    const revoked = status === UserStatus.DISABLED ? await this.tokens.revokeAllSessions(target.id) : 0;

    return { ok: true, status, revoked_sessions: revoked, is_owner: Boolean(isOwner) };
  }

  /* ============================================================
     内部工具
     ============================================================ */

  /** 取本企业成员；跨企业的 id 一律按"不存在"处理，不暴露它存在 */
  private async requireSameEnterprise(enterpriseId: string, targetUserId: string): Promise<UserEntity> {
    const target = await this.users.findOne({ where: { id: targetUserId } });
    if (!target || !target.enterpriseId || String(target.enterpriseId) !== String(enterpriseId)) {
      throw new BizException(ErrorCode.PARAM_INVALID, '该账号不属于本企业');
    }
    return target;
  }

  private toView(e: EnterpriseEntity): EnterpriseView {
    return {
      id: String(e.id),
      code: e.code,
      name: e.name,
      status: e.status,
      quota_bytes: String(e.quotaBytes ?? '0'),
      owner_user_id: e.ownerUserId ? String(e.ownerUserId) : null,
      expire_at: e.expireAt ? new Date(e.expireAt).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
      created_at: new Date(e.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  }

  private toUserView(u: UserEntity, enterprise: EnterpriseEntity | null): EnterpriseUserView {
    return {
      id: u.id,
      username: u.username,
      phone: u.phone,
      status: u.status,
      is_owner: Boolean(enterprise?.ownerUserId && String(enterprise.ownerUserId) === u.id),
      must_change_password: u.mustChangePassword === 1,
      created_at: new Date(u.createdAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
  }

  /** 供 auth 模块复用：确认企业可用（pending/disabled 一律不可用） */
  async findActiveEnterprise(enterpriseId: string): Promise<EnterpriseEntity | null> {
    const list = await this.enterprises.find({ where: { id: enterpriseId, status: EnterpriseStatus.ACTIVE } });
    return list.length ? (list[0] ?? null) : null;
  }

  /** 批量取企业（供列表渲染所有者名等场景预留） */
  async findEnterprisesByIds(ids: string[]): Promise<EnterpriseEntity[]> {
    if (!ids.length) return [];
    return this.enterprises.find({ where: { id: In(ids) } });
  }
}

/* ────────────────────────── 工具 ────────────────────────── */

/**
 * 生成初始密码：12 位，必含大小写、数字、符号各一。
 *
 * 用 `crypto.randomInt` 而不是 `Math.random`：初始密码是真实凭据，
 * 不能用可预测的伪随机。（`randomToken()` 也可以，但它返回的字符集含 `-_`，
 * 口头转达容易出错，所以这里自定义字符集。）
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
  // Fisher-Yates 洗牌，避免"必含字符"固定在前四位被猜出来
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}
