import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuthUser, CurrentUser } from '../../common/auth/current-user.decorator';
import { BizException, ErrorCode } from '../../common/error/error-code';
import { UserRole } from '../user/entities/user-status.enum';
import { UserEntity } from '../user/entities/user.entity';
import { ENTERPRISE_PERMISSIONS, PLATFORM_PERMISSIONS } from './console-permissions';
import { ConsoleEnterpriseView, ConsoleSessionView } from './dto/console.vo';
import { EnterpriseRole, EnterpriseStatus } from './entities/enterprise.entity';
import { EnterpriseService } from './enterprise.service';

/**
 * 管理端会话（`GET /api/console/session`）。
 *
 * **这是进管理端的唯一判据**：一次拿到 `scope` + `permissions`，
 * 前端按白名单渲染菜单，不再靠"试调接口看返回码"来推测身份（v2 §7.1）。
 *
 * 返回值分三种：
 *
 * - 平台管理员 → `scope=platform`，全量 `platform.*`，`enterprise=null`
 * - 企业管理员（`enterprise_role=1` 且企业 active）→ `scope=enterprise`，四个 `enterprise.*`
 * - 其它（个人用户 / 企业普通成员）→ `1004`，不允许进管理端
 */
@ApiTags('管理端 console')
@ApiBearerAuth('bearer')
@Controller('console')
export class ConsoleController {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly enterprise: EnterpriseService,
  ) {}

  @ApiOperation({
    summary: '管理端会话（进管理端的唯一判据）',
    description:
      '返回 `scope`（`platform` / `enterprise`）与 `permissions[]` 白名单。\n\n' +
      '平台管理员：全量 `platform.*`，`enterprise` 为 `null`。\n' +
      '企业管理员：四个 `enterprise.*`，并带企业摘要（成员数、是否主管理员）。\n' +
      '个人用户 / 企业普通成员：`1004` —— 不允许进管理端。\n\n' +
      '企业非 `active`：`2011` 待审核 / `2012` 已驳回（message 带原因）/ `2007` 已停用。',
  })
  @ApiOkResponse({ description: '会话信息', type: ConsoleSessionView })
  @Get('session')
  async session(@CurrentUser() user: AuthUser): Promise<ConsoleSessionView> {
    const serverTime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    /* 平台管理员：全量视图 */
    if (user.role === UserRole.ADMIN) {
      return {
        operator: user.username,
        operator_id: user.id,
        scope: 'platform',
        permissions: [...PLATFORM_PERMISSIONS],
        enterprise: null,
        server_time: serverTime,
      };
    }

    /* 企业管理员：必须是 enterprise_role = 1 且企业 active */
    if (!user.enterpriseId) {
      throw new BizException(ErrorCode.FORBIDDEN, '该账号不允许进入管理端');
    }
    const entity = await this.users.findOne({ where: { id: user.id } });
    if (!entity || entity.enterpriseRole !== EnterpriseRole.ADMIN) {
      throw new BizException(ErrorCode.FORBIDDEN, '该账号不允许进入管理端');
    }

    const enterprise = await this.enterprise.findEnterprise(String(user.enterpriseId));
    if (!enterprise) throw new BizException(ErrorCode.ENTERPRISE_UNAVAILABLE, '企业不存在');
    switch (enterprise.status) {
      case EnterpriseStatus.ACTIVE:
        break;
      case EnterpriseStatus.PENDING:
        throw new BizException(ErrorCode.ENTERPRISE_PENDING_REVIEW);
      case EnterpriseStatus.REJECTED:
        throw new BizException(
          ErrorCode.ENTERPRISE_REJECTED,
          enterprise.rejectReason ? `企业注册未通过：${enterprise.rejectReason}` : '企业注册未通过',
        );
      default:
        throw new BizException(ErrorCode.ENTERPRISE_UNAVAILABLE, '企业已停用，请联系平台');
    }

    const memberCount = await this.enterprise.countMembers(String(enterprise.id));
    const view: ConsoleEnterpriseView = {
      id: String(enterprise.id),
      code: enterprise.code,
      name: enterprise.name,
      status: enterprise.status,
      expire_at: enterprise.expireAt
        ? new Date(enterprise.expireAt).toISOString().replace(/\.\d{3}Z$/, 'Z')
        : null,
      member_count: memberCount,
      is_owner: Boolean(enterprise.ownerUserId && String(enterprise.ownerUserId) === user.id),
    };

    return {
      operator: user.username,
      operator_id: user.id,
      scope: 'enterprise',
      permissions: [...ENTERPRISE_PERMISSIONS],
      enterprise: view,
      server_time: serverTime,
    };
  }
}
