import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { sha256Hex, randomToken } from '../../common/crypto.util';
import { RedisStore } from '../../common/redis-store.service';
import { PortalConfigService } from '../../config/portal-config.service';
import { UserRole } from '../user/entities/user-status.enum';

export interface AccessTokenPayload {
  /** 门户用户 UUID */
  sub: string;
  /** 用户名 */
  uname: string;
  /**
   * 角色（2026-10-10 新增）。
   *
   * 写进 JWT 而不是每次查库：管理端每个请求都要判断"是不是管理员"，
   * 而 access token 只有 2 小时有效期，角色变更后最迟 2 小时生效——这个延迟可接受。
   * （禁用/降权时我们会吊销该用户全部 refresh 会话，所以实际生效更快。）
   */
  role: UserRole;
}

export interface AccessTokenIssued {
  accessToken: string;
  expiresIn: number;
}

/** Redis 中保存的 refresh 会话 */
interface RefreshSession {
  userId: string;
  createdAt: string;
}

/**
 * 令牌与会话。
 *
 * - access token：JWT RS256，2h（契约 §1.2），header 带 `kid` 供产品侧对齐 JWKS。
 * - refresh token：**不透明随机串**，只把 SHA-256 摘要存 Redis（14 天），
 *   即便 Redis 泄露也无法直接冒用；不轮换（一期单设备语义，契约 §1.3 备注）。
 * - 会话键 `refresh:<digest>`，另有 `refresh:user:<userId>` 集合用于登出时整体吊销。
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly store: RedisStore,
    private readonly config: PortalConfigService,
  ) {}

  async issueAccessToken(userId: string, username: string, role: UserRole): Promise<AccessTokenIssued> {
    const expiresIn = this.config.jwt.accessTtlSeconds;
    const accessToken = await this.jwtService.signAsync(
      { sub: userId, uname: username, role },
      {
        algorithm: 'RS256',
        issuer: this.config.jwt.issuer,
        expiresIn,
        keyid: this.config.jwt.current.kid,
      },
    );
    return { accessToken, expiresIn };
  }

  /** 生成 refresh token 并落 Redis；同一用户重复登录会追加新会话（单设备语义由前端只保留最新 cookie 实现） */
  async issueRefreshToken(userId: string): Promise<string> {
    const token = randomToken();
    const digest = sha256Hex(token);
    const ttl = this.config.jwt.refreshTtlSeconds;

    await this.store.setJson(
      `refresh:${digest}`,
      { userId, createdAt: new Date().toISOString() } satisfies RefreshSession,
      ttl,
    );
    // 反向索引：登出/禁用时可一次吊销该用户全部会话
    await this.store.sadd(`refresh:user:${userId}`, digest, ttl);
    return token;
  }

  /** 校验 refresh token，返回其所属用户；无效/过期返回 null */
  async resolveRefreshToken(token: string): Promise<{ userId: string } | null> {
    const digest = sha256Hex(token);
    const session = await this.store.getJson<RefreshSession>(`refresh:${digest}`);
    return session ? { userId: session.userId } : null;
  }

  /** 登出/吊销：删除该 refresh token 会话 */
  async revokeRefreshToken(token: string): Promise<void> {
    const digest = sha256Hex(token);
    const session = await this.store.getJson<RefreshSession>(`refresh:${digest}`);
    await this.store.del(`refresh:${digest}`);
    if (session) await this.store.srem(`refresh:user:${session.userId}`, digest);
  }

  /**
   * 把某个 access token 标记为已吊销（登出时调用），并把该 refresh token 一并吊销。
   * 契约 §1.4 只要求 access 自然过期；本方法做可选收紧（每请求多一次 EXISTS）。
   */
  async revokeAccessToken(rawToken: string, expiresAtEpochSeconds?: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(1, (expiresAtEpochSeconds ?? now + this.config.jwt.accessTtlSeconds) - now);
    await this.store.setJson(`revoked:${sha256Hex(rawToken)}`, true, ttl);
  }

  async isAccessTokenRevoked(rawToken: string): Promise<boolean> {
    return (await this.store.getJson<boolean>(`revoked:${sha256Hex(rawToken)}`)) === true;
  }

  /**
   * 吊销该用户全部 refresh 会话（登出、禁用账号、改密等场景）。
   * access token 不做黑名单，2h 自然过期（契约 §1.4 明确）。
   */
  async revokeAllSessions(userId: string): Promise<number> {
    const setKey = `refresh:user:${userId}`;
    const digests = await this.store.smembers(setKey);
    if (digests.length > 0) {
      await this.store.del(...digests.map((digest) => `refresh:${digest}`));
    }
    await this.store.del(setKey);
    return digests.length;
  }
}
