import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { PortalConfigService } from '../../config/portal-config.service';
import { TokenService } from '../../modules/auth/token.service';
import { UserRole, UserType } from '../../modules/user/entities/user-status.enum';
import { AuthUser } from './current-user.decorator';
import { BizException, ErrorCode } from '../error/error-code';
import { IS_PUBLIC_KEY } from './public.decorator';
import { extractBearerToken } from '../util/request.util';

/**
 * 全局 JWT 鉴权（契约 §0.3）：`Authorization: Bearer <RS256 access token>`，2h 有效。
 * - 标记 @Public() 的接口放行（注册/登录/刷新/JWKS/内网接口）；
 * - 失败统一 1002，token 过期给 1003 便于前端走 refresh（契约 §0.6）；
 * - 额外查一次「是否已登出吊销」：契约只要求 access 自然过期，这里是可选收紧，
 *   由 TokenService.revokeAccessToken 写入、本 Guard 读取；
 * - 把 JWT 里的 `role` 放进 `request.user`，供 AdminGuard 与审计日志使用
 *   （2026-10-10 起管理端不再用静态 X-Admin-Key）。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly config: PortalConfigService,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = extractBearerToken(request);
    if (!token) throw new BizException(ErrorCode.UNAUTHENTICATED);

    let payload: {
      sub: string;
      uname: string;
      role?: string;
      ut?: number;
      ent?: string;
      mcp?: number;
      er?: number;
      exp?: number;
      /* 签发时刻（秒）：老 token 没有 iam 时用它回退比较 */
      iat?: number;
      /* 签发时刻（毫秒）：与「用户级作废时刻」同精度比较，避免同秒歧义 */
      iam?: number;
    };
    try {
      payload = await this.jwtService.verifyAsync<{
        sub: string;
        uname: string;
        role?: string;
        ut?: number;
        ent?: string;
        mcp?: number;
        er?: number;
        exp?: number;
      }>(token, {
        issuer: this.config.jwt.issuer,
        algorithms: ['RS256'],
      });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === 'TokenExpiredError') throw new BizException(ErrorCode.TOKEN_EXPIRED);
      throw new BizException(ErrorCode.UNAUTHENTICATED);
    }

    /*
     * 两种失效机制一起判（一次 MGET）：
     * ① 单 token 黑名单 —— 用户主动登出当前设备
     * ② 用户级作废时刻 —— 重置密码 / 禁用 / 移出企业后，该用户已签发的 access token 全部作废
     *
     * ② 是"立即全设备下线"的关键：access token 无状态且服务端不存它，
     * 只删 refresh 只能让它 2 小时后失效。
     */
    if (
      await this.tokens.isAccessTokenRevoked(token, {
        sub: payload.sub,
        iat: payload.iat,
        iam: payload.iam,
      })
    ) {
      throw new BizException(ErrorCode.UNAUTHENTICATED, '会话已失效，请重新登录');
    }

    /* 账号性质：旧 token 没有 ut claim → 按个人用户处理（兼容增量上线） */
    const userType = payload.ut === UserType.ENTERPRISE_STAFF ? UserType.ENTERPRISE_STAFF : UserType.PERSONAL;
    const enterpriseId = payload.ent ? String(payload.ent) : null;

    /*
     * ⚠️ 企业员工但没有企业归属 → 直接拒绝。
     *
     * 不能"降级成个人域"：那会让写入落到 enterprise_id = 0 下，形成谁都不该看到、
     * 又确实存在的数据。这里宁可不让他用，让他重新登录拿一张完整 token。
     */
    if (userType === UserType.ENTERPRISE_STAFF && !enterpriseId) {
      throw new BizException(ErrorCode.UNAUTHENTICATED, '企业员工 token 缺少企业归属，请重新登录');
    }

    // 旧版 token 没有 role claim → 一律按普通用户处理（绝不因为缺失就放行管理员）
    request.user = {
      id: payload.sub,
      username: payload.uname,
      role: payload.role === UserRole.ADMIN ? UserRole.ADMIN : UserRole.USER,
      userType,
      enterpriseId,
      mustChangePassword: payload.mcp === 1,
      // 旧 token 没有 er → null；企业接口那边会判成"不是管理员"，fail-closed
      enterpriseRole: payload.er === 0 || payload.er === 1 ? payload.er : null,
    };
    return true;
  }
}
