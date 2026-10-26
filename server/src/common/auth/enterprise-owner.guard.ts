import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';

import { UserRole } from '../../modules/user/entities/user-status.enum';
import { EnterpriseEntity, EnterpriseStatus } from '../../modules/enterprise/entities/enterprise.entity';
import { AuthUser } from './current-user.decorator';
import { BizException, ErrorCode } from '../error/error-code';

/** 带企业上下文的请求（由 EnterpriseOwnerGuard 填充 `enterprise`） */
export interface EnterpriseRequest extends Request {
  user?: AuthUser;
  enterprise?: EnterpriseEntity;
}

/**
 * 企业所有者守卫（`/api/enterprise/*`）。
 *
 * ## 判据只有一个
 *
 * ```
 * enterprise.owner_user_id === 当前登录用户 id
 * ```
 *
 * ⚠️ **不要写成 `findOne()` 不带条件**——那会取到"任意一家企业"，
 * 于是任何企业员工都能通过。这是本文件最容易写错的地方。
 *
 * ## 为什么平台管理员也被拒
 *
 * 平台管理员的权限在 `/api/admin/*`（跨企业）。让他同时能走企业端，等于
 * 绕开了"企业归属从登录态取"这条约束，也模糊了两套接口的边界。
 *
 * ## 为什么每次都要查库
 *
 * 所有者可能被**移交**，而 token 里的 `ent` 在两小时内不会变。若只信 token，
 * 旧所有者移交后还能继续管——所以这里必须回源确认当前所有者是谁。
 * 单次主键查询，走 `enterprise.id` 索引，代价可接受。
 */
@Injectable()
export class EnterpriseOwnerGuard implements CanActivate {
  constructor(
    @InjectRepository(EnterpriseEntity)
    private readonly enterprises: Repository<EnterpriseEntity>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<EnterpriseRequest>();
    const user = request.user;

    if (!user) {
      throw new BizException(ErrorCode.FORBIDDEN, '企业端路由未经过 JWT 校验（请检查是否误标 @Public()）');
    }
    if (user.role === UserRole.ADMIN) {
      throw new BizException(ErrorCode.OWNER_ONLY, '平台管理员请使用管理端接口');
    }
    if (!user.enterpriseId) {
      throw new BizException(ErrorCode.ENTERPRISE_UNAVAILABLE, '当前账号没有企业归属');
    }

    const enterprise = await this.enterprises.findOne({ where: { id: String(user.enterpriseId) } });
    if (!enterprise || enterprise.status !== EnterpriseStatus.ACTIVE) {
      throw new BizException(ErrorCode.ENTERPRISE_UNAVAILABLE);
    }
    if (String(enterprise.ownerUserId ?? '') !== user.id) {
      throw new BizException(ErrorCode.OWNER_ONLY);
    }

    // 交给 controller：避免它再查一次
    request.enterprise = enterprise;
    return true;
  }
}
