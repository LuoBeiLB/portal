import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { PortalConfigService } from '../config/portal-config.service';
import { TokenService } from '../modules/auth/token.service';
import { UserRole } from '../modules/user/entities/user-status.enum';
import { AuthUser } from './current-user.decorator';
import { BizException, ErrorCode } from './error-code';
import { IS_PUBLIC_KEY } from './public.decorator';
import { extractBearerToken } from './request.util';

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

    let payload: { sub: string; uname: string; role?: string; exp?: number };
    try {
      payload = await this.jwtService.verifyAsync<{ sub: string; uname: string; role?: string; exp?: number }>(token, {
        issuer: this.config.jwt.issuer,
        algorithms: ['RS256'],
      });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === 'TokenExpiredError') throw new BizException(ErrorCode.TOKEN_EXPIRED);
      throw new BizException(ErrorCode.UNAUTHENTICATED);
    }

    if (await this.tokens.isAccessTokenRevoked(token)) {
      throw new BizException(ErrorCode.UNAUTHENTICATED, 'token 已登出');
    }

    // 旧版 token 没有 role claim → 一律按普通用户处理（绝不因为缺失就放行管理员）
    request.user = {
      id: payload.sub,
      username: payload.uname,
      role: payload.role === UserRole.ADMIN ? UserRole.ADMIN : UserRole.USER,
    };
    return true;
  }
}
