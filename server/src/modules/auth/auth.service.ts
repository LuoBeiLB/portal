import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { uuidv7 } from '../../common/crypto.util';
import { BizException, ErrorCode } from '../../common/error-code';
import { UserStatus } from '../user/entities/user-status.enum';
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

export interface AuthResult {
  tokens: AuthTokens;
  user: { id: string; username: string };
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
        await manager.insert(UserEntity, {
          id,
          username: dto.username,
          phone: dto.phone ?? null,
          passwordHash,
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
    const tokens = await this.issueTokens(user.id, user.username);

    return {
      tokens,
      user: { id: user.id, username: user.username },
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

    const tokens = await this.issueTokens(user.id, user.username);
    return { tokens, user: { id: user.id, username: user.username } };
  }

  /**
   * 刷新（契约 §1.3）：依赖 refresh Cookie。
   * refresh 不轮换、单设备语义（一期从简）。
   */
  async refresh(rawToken: string | undefined): Promise<AuthTokens & { user: { id: string; username: string } }> {
    if (!rawToken) throw new BizException(ErrorCode.UNAUTHENTICATED);

    const session = await this.tokens.resolveRefreshToken(rawToken);
    if (!session) throw new BizException(ErrorCode.UNAUTHENTICATED);

    const user = await this.users.findOne({ where: { id: session.userId } });
    if (!user) throw new BizException(ErrorCode.UNAUTHENTICATED);
    if (user.status === UserStatus.DISABLED) {
      await this.tokens.revokeAllSessions(user.id);
      throw new BizException(ErrorCode.ACCOUNT_DISABLED);
    }

    const access = await this.tokens.issueAccessToken(user.id, user.username);
    return {
      access_token: access.accessToken,
      expires_in: access.expiresIn,
      refresh_token: rawToken,
      user: { id: user.id, username: user.username },
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

  private async issueTokens(userId: string, username: string): Promise<AuthTokens> {
    const access = await this.tokens.issueAccessToken(userId, username);
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
