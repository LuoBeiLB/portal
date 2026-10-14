import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

import { UserRole } from '../../modules/user/entities/user-status.enum';

/** 当前登录用户（由 JwtAuthGuard 注入） */
export interface AuthUser {
  /** 门户用户 UUID，即 JWT 的 sub */
  id: string;
  username: string;
  /**
   * 角色，来自**已验证的 JWT**（不是请求体、不是请求头）。
   * 管理端鉴权与审计日志里的"操作人"都以此为准。
   */
  role: UserRole;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  if (!request.user) {
    throw new Error('CurrentUser 只能在 JwtAuthGuard 之后使用');
  }
  return request.user;
});
