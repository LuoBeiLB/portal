import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { sha256Hex, randomToken } from '../../common/util/crypto.util';
import { RedisStore } from '../../common/redis/redis-store.service';
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

  /**
   * 账号性质（2026-10-19 新增）：0 个人 / 1 企业员工。
   *
   * 产品侧据此决定走个人域还是企业域。**缺失按 0 处理** —— 兼容增量上线期间
   * 已签发的旧 token。
   */
  ut?: number;

  /**
   * 企业 id（2026-10-19 新增）。仅 `ut = 1` 的企业员工才有。
   *
   * 产品侧靠它建立租户上下文（每张表、每条 SQL 都按它隔离）。
   * **`ut = 1` 但缺 `ent` 时产品侧必须拒绝**，不能退化成个人域 ——
   * 否则企业数据会落到 `enterprise_id = 0` 下。
   */
  ent?: string;

  /** 首登必须改密（2026-10-19 新增）：为 1 时只应放行改密接口 */
  mcp?: number;

  /**
   * 企业内角色（2026-10-27 新增，v2）：0 普通成员 / 1 企业管理员；非企业账号不带此 claim。
   *
   * 放 token 里的理由：`/api/enterprise/*` 每个请求都要判"是不是企业管理员"，
   * 回查 `u_user` 等于白白多一次查询。**任何改变该角色的路径都必须吊销会话**
   * （移交、降权），否则最长 2 小时内会用到旧权限 —— 这个延迟与 `role` 的既有口径一致。
   */
  er?: number;

  /**
   * 毫秒级签发时刻（自定义 claim，2026-11-03 新增）。
   *
   * 标准 `iat` 只有秒精度。管理员重置密码时要在同一秒内区分"重置前签发"与"重置后签发"，
   * 秒级做不到（只能二选一：漏杀旧会话，或误杀刚登录的新会话）。加毫秒后两者都精确。
   *
   * 老 token 没有这个 claim → 回退到秒级比较（见 `isAccessTokenRevoked`）。
   */
  iam?: number;
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

  async issueAccessToken(
    userId: string,
    username: string,
    role: UserRole,
    extra?: {
      userType?: number;
      enterpriseId?: string | null;
      mustChangePassword?: number;
      enterpriseRole?: number | null;
    },
  ): Promise<AccessTokenIssued> {
    const expiresIn = this.config.jwt.accessTtlSeconds;
    // 只在有值时才写入可选 claim，避免 JWT 里出现一堆 null 字段
    const claims: AccessTokenPayload = {
      sub: userId,
      uname: username,
      role,
      ut: extra?.userType ?? 0,
      /*
       * 毫秒级签发时刻（自定义 claim）。
       *
       * 为什么不用标准 `iat`：它只有**秒**精度。管理员重置密码与用户在同一秒内签发 token 时，
       * 秒级比较无法区分"重置前签发"与"重置后签发"，只能二选一：
       * - 用 `<` → 同一秒的旧会话漏杀（管理员以为踢掉了，其实没有）
       * - 用 `<=` → 同一秒内重新登录被误杀
       * 加毫秒后两者都能精确判断（见 isAccessTokenRevoked）。
       */
      iam: Date.now(),
    };
    if (extra?.enterpriseId) claims.ent = String(extra.enterpriseId);
    if (extra?.mustChangePassword) claims.mcp = 1;
    if (extra?.enterpriseRole === 0 || extra?.enterpriseRole === 1) claims.er = extra.enterpriseRole;

    const accessToken = await this.jwtService.signAsync(
      claims,
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

  /**
   * 判断 access token 是否已失效（两种机制，一次 MGET 一起判）。
   *
   * ## ① 单 token 黑名单 `revoked:<sha256>`（登出当前设备）
   *
   * 精确吊销一张 token。只在"登出时手里正好有那张 token"才写得进去。
   *
   * ## ② 用户级作废时刻 `user:auth-invalid-before:<userId>`（重置密码 / 停用 / 移出企业）
   *
   * access token 是无状态的，服务端**没有存**它，所以"删除 access token"这个动作
   * 没有对象。但"让某时刻之前签发的全部 token 失效"是可以做到的：
   * 重置密码时写下一个秒级时间戳，之后每次校验比较 `iat`。
   *
   * 效果等价于"立即全设备下线"，成本却只有一个 key ——
   * 不必给每个 token 建集合（Redis 集合成员没有独立 TTL，会无限膨胀）。
   *
   * ### 为什么用严格小于
   *
   * `iat` 是秒级，作废时刻也是秒级。用 `<=` 会把"同一秒内用新密码刚登录拿到的 token"
   * 一起误杀；用 `<` 则放行它，而旧会话这一秒内拿不到新 token（refresh 已被删），
   * 不存在安全缺口。
   *
   * @param rawToken 原始 JWT 字符串
   * @param claims 已验签的 payload（需要 `sub` 与 `iat`）
   */
  async isAccessTokenRevoked(
    rawToken: string,
    claims: { sub?: string; iat?: number; iam?: number } = {},
  ): Promise<boolean> {
    const revokedKey = `revoked:${sha256Hex(rawToken)}`;
    const userId = claims.sub ?? '';
    const invalidBeforeKey = userId ? `user:auth-invalid-before:${userId}` : '';

    const values = await this.store.getStrings(
      invalidBeforeKey ? [revokedKey, invalidBeforeKey] : [revokedKey],
    );

    if (values[0] === 'true') return true;

    const marker = invalidBeforeKey ? values[1] : null;
    if (marker === null) return false;

    const invalidBeforeMs = Number(marker);
    if (!Number.isFinite(invalidBeforeMs)) return false;

    /*
     * 优先用毫秒 claim `iam`：精确到毫秒，不会出现"同一秒内分不出先后"。
     *
     * 老 token（改造前签发）没有 iam，回退到秒级：把 iat 视为该秒的起点，
     * 只要作废时刻落在这一秒内就吊销 —— **宁可误杀一秒，不漏杀**。
     * 漏杀的代价是"管理员以为踢下线了，其实没踢"，属于安全缺陷；
     * 误杀的代价是用户点一次重新登录。
     */
    if (typeof claims.iam === 'number') {
      return claims.iam < invalidBeforeMs;
    }
    if (claims.iat === undefined) return true;
    return claims.iat * 1000 < invalidBeforeMs;
  }

  /**
   * 吊销该用户全部会话：删 refresh + **写下作废时刻让已签发的 access token 也立刻失效**。
   *
   * 2026-11-03 修：此前只删 refresh，已签发的 access token 还能用到自然过期（最长 2h），
   * 表现为"管理员重置密码后，员工刷新页面仍然是登录状态"。见 `isAccessTokenRevoked` ②。
   *
   * 调用点：登出（单设备走 `revokeAccessToken`）、改密、禁用账号、重置密码、移出企业。
   */
  async revokeAllSessions(userId: string): Promise<number> {
    /*
     * 先写作废时刻，再删 refresh：
     * 反过来会出现"refresh 已删、作废时刻没写上"的窗口（Redis 中途失败），
     * 那时旧 access token 仍有效，等于吊销失败但不报错。
     */
    await this.store.setString(
      `user:auth-invalid-before:${userId}`,
      /* **毫秒**时间戳：与 token 里的 `iam` 同精度，避免同秒歧义 */
      String(Date.now()),
      /* TTL 必须覆盖"作废时刻之前签发、但还没过期"的最长 access token */
      this.config.jwt.accessTtlSeconds + 60,
    );

    const setKey = `refresh:user:${userId}`;
    const digests = await this.store.smembers(setKey);
    if (digests.length > 0) {
      await this.store.del(...digests.map((digest) => `refresh:${digest}`));
    }
    await this.store.del(setKey);
    return digests.length;
  }
}
