import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

/** 当前登录用户（由 JwtAuthGuard 注入） */
export interface AuthUser {
  /** 门户用户 UUID，即 JWT 的 sub */
  id: string;
  username: string;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  if (!request.user) {
    throw new Error('CurrentUser 只能在 JwtAuthGuard 之后使用');
  }
  return request.user;
});
