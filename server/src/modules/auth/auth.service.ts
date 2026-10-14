import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { uuidv7 } from '../../common/crypto.util';
import { BizException, ErrorCode } from '../../common/error-code';
import { UserRole, UserStatus } from '../user/entities/user-status.enum';
import { UserEntity } from '../user/entities/user.entity';
import { WalletEntity } from '../wallet/entities/wallet.entity';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface AuthTokens {
  access_token: string;
  expires_in: number;
  /** 由调用方写入 Set-Cookie，不进入响应 body */
  refresh_token: string;
}

/**
 * 登录 / 注册 / 刷新 响应里的用户信息（三处形状保持一致）。
 *
 * `role` / `status` 是给**产品侧代理登录**用的（2026-10-12 新增）：
 * 产品拿用户填的账号密码调 `POST /api/auth/login`，成功后需要立刻知道
 * "这个账号是否可用、是什么角色"，否则还得再调一次接口查状态。
 * 详见 `docs/09-契约v1.1差异与补充.md` 的「产品代理登录」一节。
 */
export interface AuthUserView {
  id: string;
  username: string;
  role: UserRole;
  /** 0 正常 / 1 禁用（契约 §0.6 的 2004 对应禁用态） */
  status: UserStatus;
}

export interface AuthResult {
  tokens: AuthTokens;
  user: AuthUserView;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly dataSource: DataSource,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * 注册（契约 §1.1）：**注册即建钱包（balance=0）**，用户与钱包在同一事务内落库；
   * 注册成功即自动登录，响应同 1.2 成功结构。
   */
  async register(dto: RegisterDto): Promise<AuthResult & { profile: RegisterProfile }> {
    const existingName = await this.users.findOne({ where: { username: dto.username } });
    if (existingName) throw new BizException(ErrorCode.USERNAME_EXISTS);

    if (dto.phone) {
      const existingPhone = await this.users.findOne({ where: { phone: dto.phone } });
      if (existingPhone) throw new BizException(ErrorCode.PHONE_REGISTERED);
    }

    const passwordHash = await this.password.hash(dto.password);
    const id = uuidv7();

    try {
      await this.dataSource.transaction(async (manager) => {
        // 时间戳**不在这里写**：`created_at` / `updated_at` 由 MySQL 按库侧
        // `DEFAULT CURRENT_TIMESTAMP(3)` 生成（2026-10-12 统一口径）。
        // 应用若显式给值，TypeORM 会序列化成 UTC 墙面时间，与库生成列差 8 小时 ——
        // 详见 config/database.options.ts 顶部说明。
        await manager.insert(UserEntity, {
          id,
          username: dto.username,
          phone: dto.phone ?? null,
          passwordHash,
          // ⚠️ 角色**写死普通用户**，绝不从请求体读取 —— 否则任何人都能注册出管理员。
          // 管理员只能由环境变量 bootstrap 或 POST /api/admin/admins 创建。
          role: UserRole.USER,
          status: UserStatus.NORMAL,
        });
        await manager.insert(WalletEntity, { userId: id, balanceCents: '0' });
      });
    } catch (error) {
      // 并发注册时唯一索引兜底：把 DB 冲突翻译成契约错误码
      if (isDuplicateEntry(error)) {
        const target = duplicateTargetOf(error);
        if (target.includes('phone')) throw new BizException(ErrorCode.PHONE_REGISTERED);
        throw new BizException(ErrorCode.USERNAME_EXISTS);
      }
      throw error;
    }

    const user = await this.users.findOneOrFail({ where: { id } });
    const tokens = await this.issueTokens(user.id, user.username, user.role);

    return {
      tokens,
      user: { id: user.id, username: user.username, role: user.role, status: user.status },
      profile: {
        id: user.id,
        username: user.username,
        phone: user.phone,
        created_at: toIso(user.createdAt) ?? '',
      },
    };
  }

  /** 登录（契约 §1.2）：username 支持用户名或手机号；错误一律 2003，避免账号枚举 */
  async login(dto: LoginDto): Promise<AuthResult> {
    const identifier = dto.username.trim();
    const user = await this.users.findOne({
      where: [{ username: identifier }, { phone: identifier }],
    });

    if (!user) throw new BizException(ErrorCode.BAD_CREDENTIALS);
    if (user.status === UserStatus.DISABLED) throw new BizException(ErrorCode.ACCOUNT_DISABLED);

    const ok = await this.password.verify(user.passwordHash, dto.password);
    if (!ok) throw new BizException(ErrorCode.BAD_CREDENTIALS);

    const tokens = await this.issueTokens(user.id, user.username, user.role);
    return { tokens, user: { id: user.id, username: user.username, role: user.role, status: user.status } };
  }

  /**
   * 刷新（契约 §1.3）：依赖 refresh Cookie。
   * refresh 不轮换、单设备语义（一期从简）。
   */
  async refresh(rawToken: string | undefined): Promise<AuthTokens & { user: AuthUserView }> {
    if (!rawToken) throw new BizException(ErrorCode.UNAUTHENTICATED);

    const session = await this.tokens.resolveRefreshToken(rawToken);
    if (!session) throw new BizException(ErrorCode.UNAUTHENTICATED);

    const user = await this.users.findOne({ where: { id: session.userId } });
    if (!user) throw new BizException(ErrorCode.UNAUTHENTICATED);
    if (user.status === UserStatus.DISABLED) {
      await this.tokens.revokeAllSessions(user.id);
      throw new BizException(ErrorCode.ACCOUNT_DISABLED);
    }

    const access = await this.tokens.issueAccessToken(user.id, user.username, user.role);
    return {
      access_token: access.accessToken,
      expires_in: access.expiresIn,
      refresh_token: rawToken,
      user: { id: user.id, username: user.username, role: user.role, status: user.status },
    };
  }

  /**
   * 登出（契约 §1.4）：吊销 refresh 会话；access 按契约不做黑名单。
   * 由于 cookie 被限定在 /api/auth/refresh 路径（契约 §1.2），登出时按用户整体吊销 refresh，
   * 并对当前 access token 做一次可选吊销（收紧到"登出即失效"）。
   */
  async logout(userId: string, accessToken?: string, expiresAt?: number): Promise<{ ok: true }> {
    await this.tokens.revokeAllSessions(userId);
    if (accessToken) {
      await this.tokens.revokeAccessToken(accessToken, expiresAt);
    }
    return { ok: true };
  }

  /**
   * 修改自己的密码（`POST /api/auth/password`）。
   *
   * 行为：
   * 1. 校验旧密码（防止 access token 被盗后直接改密锁死账号）；
   * 2. 写入新哈希；
   * 3. **吊销该用户全部 refresh 会话** —— 密码已变，旧会话必须失效（所有设备强制重登）；
   * 4. 拒绝"新密码与旧密码相同"（否则等于没改，却把所有人踢下线）。
   */
  async changePassword(
    user: { id: string; username: string; role: UserRole },
    oldPassword: string,
    newPassword: string,
  ): Promise<{ ok: true; revoked_sessions: number }> {
    const entity = await this.users.findOne({ where: { id: user.id } });
    if (!entity) throw new BizException(ErrorCode.UNAUTHENTICATED);

    const ok = await this.password.verify(entity.passwordHash, oldPassword);
    if (!ok) throw new BizException(ErrorCode.BAD_CREDENTIALS, '当前密码错误');

    if (oldPassword === newPassword) {
      throw new BizException(ErrorCode.PARAM_INVALID, '新密码不能与当前密码相同');
    }

    const passwordHash = await this.password.hash(newPassword);
    // `updated_at` 交给库：列上有 ON UPDATE CURRENT_TIMESTAMP(3)，只要本次 UPDATE
    // 改了别的列就会自动刷新（已实测，见 (已删的排查脚本)）
    await this.users.update({ id: user.id }, { passwordHash });

    const revoked = await this.tokens.revokeAllSessions(user.id);
    return { ok: true, revoked_sessions: revoked };
  }

  private async issueTokens(userId: string, username: string, role: UserRole): Promise<AuthTokens> {
    const access = await this.tokens.issueAccessToken(userId, username, role);
    const refreshToken = await this.tokens.issueRefreshToken(userId);
    return { access_token: access.accessToken, expires_in: access.expiresIn, refresh_token: refreshToken };
  }
}

export interface RegisterProfile {
  id: string;
  username: string;
  phone: string | null;
  created_at: string;
}

/** 统一 UTC ISO 8601（契约 §0.4）：`2026-10-05T02:00:00Z`，不带毫秒；空值返回 null */
export function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

interface MysqlDuplicateError {
  errno?: number;
  code?: string;
  sqlMessage?: string;
  message?: string;
}

export function isDuplicateEntry(error: unknown): boolean {
  const candidate = error as MysqlDuplicateError;
  return candidate?.errno === 1062 || candidate?.code === 'ER_DUP_ENTRY';
}

export function duplicateTargetOf(error: unknown): string {
  const candidate = error as MysqlDuplicateError;
  return `${candidate?.sqlMessage ?? ''} ${candidate?.message ?? ''}`;
}
