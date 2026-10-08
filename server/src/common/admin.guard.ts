import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { PortalConfigService } from '../config/portal-config.service';
import { safeEqual } from './crypto.util';
import { AuthUser } from './current-user.decorator';
import { BizException, ErrorCode } from './error-code';

export const ADMIN_KEY_HEADER = 'x-admin-key';

/**
 * 管理端鉴权（契约 §6）：一期用 `X-Admin-Key` 静态密钥；二期换角色校验。
 *
 * 用法：管理端路由标 `@Public()` + `@UseGuards(AdminGuard)`。
 * 标 @Public() 的原因：全局 JwtAuthGuard 会先要求 Bearer token，而契约允许管理端
 * 只用 X-Admin-Key（系统级凭证）。所以管理端路由的鉴权**完全由本 Guard 负责**。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: PortalConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    // 路径一：合法静态密钥（一期主用）
    const provided = request.headers[ADMIN_KEY_HEADER];
    const key = Array.isArray(provided) ? provided[0] : provided;
    const expected = this.config.security.adminKey;
    if (key && expected && safeEqual(expected, key)) return true;

    // 路径二：已登录用户 —— 二期 `u_user` 引入 role 列后在此校验角色，当前一律拒绝
    if (request.user) throw new BizException(ErrorCode.FORBIDDEN, '需要管理员权限');

    throw new BizException(ErrorCode.FORBIDDEN);
  }
}
