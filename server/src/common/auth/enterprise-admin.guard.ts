import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';

import { UserRole } from '../../modules/user/entities/user-status.enum';
import { UserEntity } from '../../modules/user/entities/user.entity';
import { EnterpriseEntity, EnterpriseRole, EnterpriseStatus } from '../../modules/enterprise/entities/enterprise.entity';
import { AuthUser } from './current-user.decorator';
import { BizException, ErrorCode } from '../error/error-code';

/** 带企业上下文的请求（由 EnterpriseAdminGuard 填充 `enterprise`） */
export interface EnterpriseRequest extends Request {
  user?: AuthUser;
  enterprise?: EnterpriseEntity;
}

/**
 * 企业管理员守卫（`/api/enterprise/*`）。
 *
 * ## 判据（v2 唯一口径）
 *
 * ```
 * u_user.enterprise_role = 1  AND  enterprise.status = 'active'
 * ```
 *
 * ⚠️ **不要用 `enterprise.owner_user_id === me` 判**（那是 v1 的做法）：
 * 那样一个企业只能有一个管理员，扩到多个就得改模型。
 * `owner_user_id` 只表示"创建者 / 主管理员 / 资源持有人 / 付费方"。
 *
 * ## 为什么平台管理员也被拒
 *
 * 平台管理员的权限在 `/api/admin/*`（跨企业）。让他也能走企业端，等于模糊了两套接口的边界，
 * 也绕开了"企业归属从登录态取"这条约束。
 *
 * ## 为什么每次都要查库
 *
 * token 里的 `ent` 两小时内不会变。若只信 token，企业被停用/降权后旧 token 还能继续用。
 * 单次主键查询走索引，代价可接受；企业状态变化时还会主动吊销该企业全部会话。
 */
@Injectable()
export class EnterpriseAdminGuard implements CanActivate {
  constructor(
    @InjectRepository(EnterpriseEntity)
    private readonly enterprises: Repository<EnterpriseEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
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
    if (!enterprise) throw new BizException(ErrorCode.ENTERPRISE_UNAVAILABLE, '企业不存在');
    if (enterprise.status !== EnterpriseStatus.ACTIVE) {
      throw new BizException(ErrorCode.ENTERPRISE_UNAVAILABLE);
    }

    /*
     * 角色从库里读，不从 token 读：token 里没有 enterprise_role，
     * 且"被降成普通成员"要立刻生效，不能等 token 过期。
     */
    const entity = await this.users.findOne({ where: { id: user.id } });
    if (!entity || entity.enterpriseRole !== EnterpriseRole.ADMIN) {
      throw new BizException(ErrorCode.OWNER_ONLY);
    }

    request.enterprise = enterprise;
    return true;
  }
}
