import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

import { UserRole, UserType } from '../../modules/user/entities/user-status.enum';

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

  /** 账号性质：0 个人 / 1 企业员工（来自 JWT 的 ut，缺失按 0） */
  userType: UserType;
  /** 企业 id（来自 JWT 的 ent）；个人用户与非法 token 为 null */
  enterpriseId: string | null;
  /** 首登必须改密（来自 JWT 的 mcp） */
  mustChangePassword: boolean;
  /** 企业内角色（来自 JWT 的 er）：0 成员 / 1 管理员；非企业账号为 null */
  enterpriseRole: number | null;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
  if (!request.user) {
    throw new Error('CurrentUser 只能在 JwtAuthGuard 之后使用');
  }
  return request.user;
});
