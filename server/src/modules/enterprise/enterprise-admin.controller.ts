import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { AdminGuard } from '../../common/auth/admin.guard';
import { AuthUser, CurrentUser } from '../../common/auth/current-user.decorator';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import {
  AssignOwnerDto,
  AssignUserEnterpriseDto,
  CreateEnterpriseDto,
  EnterpriseQueryDto,
} from './dto/enterprise.dto';
import {
  EnterpriseListView,
  EnterpriseUserView,
  EnterpriseView,
  OwnerAssignedView,
} from './dto/enterprise.vo';
import { EnterpriseService } from './enterprise.service';

/**
 * 管理端 · 企业（平台管理员，**跨企业**）。
 *
 * 与 `/api/enterprise/*` 的分工：
 * - 这里：平台方开通、指定所有者、给已有账号分配企业。可以操作**任意**企业
 * - 那边：企业所有者管**自己**企业的员工，`enterprise_id` 从登录态取
 *
 * ⚠️ 同样刻意不标 `@Public()`：必须经全局 `JwtAuthGuard` 填充 `request.user`。
 */
@ApiTags('管理端 admin · 企业')
@ApiBearerAuth('bearer')
@UseGuards(AdminGuard)
@Controller('admin/enterprises')
export class EnterpriseAdminController {
  constructor(
    private readonly enterprise: EnterpriseService,
    private readonly audit: AuditService,
  ) {}

  @ApiOperation({
    summary: '企业列表',
    description: '支持按状态与关键词（编码/名称）筛选。`owner_user_id` 为 null 表示还在 pending（未指定所有者，不可用）。',
  })
  @ApiOkResponse({ description: '企业列表', type: EnterpriseListView })
  @Get()
  async list(@Query() query: EnterpriseQueryDto): Promise<EnterpriseListView> {
    return this.enterprise.listEnterprises(query);
  }

  @ApiOperation({
    summary: '建企业（流程①）',
    description:
      '只创建企业记录，状态为 `pending`、所有者留空。\n\n' +
      '**不创建任何角色** —— 角色是云存储的产品概念，由它在企业首次被访问时惰性初始化（docs/18 §4.2.1）。\n\n' +
      '建完必须再用「指定所有者」接口把企业激活，否则该企业的账号一律登录失败（`2007`）。',
  })
  @ApiOkResponse({ description: '新企业', type: EnterpriseView })
  @Post()
  @HttpCode(200)
  async create(
    @Body() dto: CreateEnterpriseDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<EnterpriseView> {
    const created = await this.enterprise.createEnterprise(dto, user.id);
    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: AuditAction.ENTERPRISE_CREATE,
      target: `enterprise:${created.id}`,
      detail: { code: created.code, name: created.name },
      ip: this.audit.ipOf(request),
    });
    return created;
  }

  @ApiOperation({
    summary: '指定 / 移交企业所有者（流程②）',
    description:
      '把某账号设为该企业所有者：**唯一管理员 + 资源默认持有人**。\n\n' +
      '首次指定会把企业从 `pending` 置为 `active`；**移交**（企业原来已有所有者）会吊销旧所有者全部会话，' +
      '让他重新登录以拿到正确的身份。\n\n' +
      '四条校验：不能是平台管理员 / 不能已属于其他企业 / 不能被禁用 / 已有所有者时按移交处理。',
  })
  @ApiOkResponse({ description: '指定结果', type: OwnerAssignedView })
  @Post(':id/owner')
  @HttpCode(200)
  async assignOwner(
    @Param('id') id: string,
    @Body() dto: AssignOwnerDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<OwnerAssignedView> {
    const result = await this.enterprise.assignOwner(id, dto.user_id, user.id);
    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: AuditAction.ENTERPRISE_OWNER_ASSIGN,
      target: `enterprise:${id}`,
      detail: { owner_user_id: dto.user_id, transferred: result.transferred },
      ip: this.audit.ipOf(request),
    });
    return result;
  }
}

/**
 * 管理端 · 给已有账号分配 / 调整企业。
 *
 * 单独一个控制器是因为路径在 `/admin/users/:id/enterprise`（属于用户子资源），
 * 与上面的 `/admin/enterprises` 不是同一棵树。
 */
@ApiTags('管理端 admin · 企业')
@ApiBearerAuth('bearer')
@UseGuards(AdminGuard)
@Controller('admin/users')
export class EnterpriseUserAdminController {
  constructor(
    private readonly enterprise: EnterpriseService,
    private readonly audit: AuditService,
  ) {}

  @ApiOperation({
    summary: '把已有账号分配 / 调整到某企业',
    description:
      '只改归属（`user_type` 置 1 + 绑定企业），**不改变所有者**。\n\n' +
      '成功后吊销该账号全部会话 —— 否则他手里的 token 还带着旧的企业归属。\n\n' +
      '目标企业必须是 `active`；目标账号不能是平台管理员、不能已属于其他企业。',
  })
  @ApiOkResponse({ description: '更新后的企业成员', type: EnterpriseUserView })
  @Post(':id/enterprise')
  @HttpCode(200)
  async assign(
    @Param('id') id: string,
    @Body() dto: AssignUserEnterpriseDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<EnterpriseUserView> {
    const result = await this.enterprise.assignUserToEnterprise(id, dto.enterprise_id);
    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: AuditAction.ENTERPRISE_USER_ASSIGN,
      target: `user:${id}`,
      detail: { enterprise_id: dto.enterprise_id },
      ip: this.audit.ipOf(request),
    });
    return result;
  }
}
