import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { UserRole } from '../modules/user/entities/user-status.enum';
import { AuthUser } from './current-user.decorator';
import { BizException, ErrorCode } from './error-code';

/**
 * 管理端鉴权（契约 §6）。
 *
 * ## 2026-10-10 起：静态密钥 → 管理员账号
 *
 * 原先用 `X-Admin-Key` 静态密钥，**无法区分操作人**：
 * `POST /admin/recharges/:id/confirm?admin_id=` 的"经办人"由前端自报、可任意伪造，
 * 而核销充值、禁用用户、重置密码都是资金/权限操作，出了问题必须能追到人。
 *
 * 现在改为：管理员就是 `role = 'admin'` 的普通用户，鉴权完全依赖**已验证的 JWT**
 * （由全局 `JwtAuthGuard` 填充 `request.user`，其中含 `role`）。
 *
 * ⚠️ 因此管理端控制器**不能再标 `@Public()`**：标了就绕过 JWT 校验，
 * 本 Guard 拿不到 `request.user`，连合法管理员也会被拒。
 *
 * 失败仍返回 **1004**（授权失败），错误码语义不变，前端处理逻辑无需改动。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const user = request.user;

    if (!user) {
      // 说明路由被误标 @Public()，或没走全局 JwtAuthGuard —— 属配置问题，不是"用户无权限"
      throw new BizException(ErrorCode.FORBIDDEN, '管理端路由未经过 JWT 校验（请检查是否误标 @Public()）');
    }

    if (user.role !== UserRole.ADMIN) {
      throw new BizException(ErrorCode.FORBIDDEN, '需要管理员权限');
    }

    return true;
  }
}
