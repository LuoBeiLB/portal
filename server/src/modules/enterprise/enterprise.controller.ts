import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { CurrentEnterprise } from '../../common/auth/current-enterprise.decorator';
import { EnterpriseOwnerGuard } from '../../common/auth/enterprise-owner.guard';
import { AuthUser, CurrentUser } from '../../common/auth/current-user.decorator';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { EnterpriseEntity } from './entities/enterprise.entity';
import {
  CreateEnterpriseUserDto,
  EnterpriseUserQueryDto,
  EnterpriseUserStatusDto,
} from './dto/enterprise.dto';
import {
  EnterpriseUserCreatedView,
  EnterpriseUserListView,
  EnterpriseUserPasswordResetView,
  EnterpriseUserStatusView,
} from './dto/enterprise.vo';
import { EnterpriseService } from './enterprise.service';

/**
 * 企业端（**企业所有者专用**，不是管理端）。
 *
 * ## 与 `/api/admin/*` 的根本区别
 *
 * | | `/api/admin/*` | `/api/enterprise/*` |
 * |---|---|---|
 * | 谁用 | 平台管理员 | 企业所有者 |
 * | 能操作谁 | **任意**企业 | **只有自己**企业 |
 * | `enterprise_id` 来源 | 请求体（跨企业需要） | **登录态，绝不从请求体取** |
 *
 * ⚠️ 最后一行是整个企业版最容易被漏掉的越权点：如果这里接受 `body.enterprise_id`，
 * 企业所有者就能把员工建到别家企业去。所以下面的 DTO **刻意没有这个字段**，
 * 并且企业 id 一律来自 `@CurrentEnterprise()`（由守卫从登录态查出来）。
 */
@ApiTags('企业端 enterprise（所有者）')
@ApiBearerAuth('bearer')
@UseGuards(EnterpriseOwnerGuard)
@Controller('enterprise')
export class EnterpriseOwnerController {
  constructor(
    private readonly enterprise: EnterpriseService,
    private readonly audit: AuditService,
  ) {}

  @ApiOperation({
    summary: '本企业员工列表',
    description: '**只返回当前所有者所在企业**的账号。跨企业的 id 一律查不到（按"不存在"处理）。',
  })
  @ApiOkResponse({ description: '员工列表', type: EnterpriseUserListView })
  @Get('users')
  async listUsers(
    @CurrentEnterprise() ent: EnterpriseEntity,
    @Query() query: EnterpriseUserQueryDto,
  ): Promise<EnterpriseUserListView> {
    return this.enterprise.listEnterpriseUsers(String(ent.id), query);
  }

  @ApiOperation({
    summary: '新建本企业员工（流程③）',
    description:
      '企业归属**由登录态决定**：新账号自动落到当前所有者所在企业，请求体里即便传 `enterprise_id` 也会被忽略（DTO 里没有这个字段）。\n\n' +
      '`user_type` 固定为 1（企业员工），首登强制改密。\n\n' +
      '返回的 `initial_password` **只在这里出现一次**，服务端只存 argon2id 哈希，之后就查不到了。',
  })
  @ApiOkResponse({ description: '新建结果（含一次性初始密码）', type: EnterpriseUserCreatedView })
  @Post('users')
  @HttpCode(200)
  async createUser(
    @CurrentEnterprise() ent: EnterpriseEntity,
    @Body() dto: CreateEnterpriseUserDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<EnterpriseUserCreatedView> {
    const result = await this.enterprise.createEnterpriseUser(String(ent.id), dto);
    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: AuditAction.ENTERPRISE_USER_CREATE,
      target: `user:${result.id}`,
      // 初始密码**不进审计日志**：日志是长期保留的，放密码等于长期留存明文凭据
      detail: { username: result.username, enterprise_id: result.enterprise_id },
      ip: this.audit.ipOf(request),
    });
    return result;
  }

  @ApiOperation({
    summary: '重置本企业员工密码',
    description: '生成新的初始密码、置首登强制改密、并**吊销该员工全部会话**（所有设备强制重登）。',
  })
  @ApiOkResponse({ description: '重置结果（含一次性初始密码）', type: EnterpriseUserPasswordResetView })
  @Post('users/:id/reset-password')
  @HttpCode(200)
  async resetPassword(
    @CurrentEnterprise() ent: EnterpriseEntity,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<EnterpriseUserPasswordResetView> {
    const result = await this.enterprise.resetEnterpriseUserPassword(String(ent.id), id);
    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: AuditAction.ENTERPRISE_USER_PASSWORD_RESET,
      target: `user:${id}`,
      detail: { enterprise_id: String(ent.id) },
      ip: this.audit.ipOf(request),
    });
    return result;
  }

  @ApiOperation({
    summary: '停用 / 恢复本企业员工',
    description:
      '停用会吊销该员工全部会话，效果是"立即下线"。\n\n' +
      '⚠️ **企业所有者本人不能被停用** —— 否则企业变成无人可管，而 `owner_user_id` 又不能指向' +
      '一个停用账号。要停用必须先移交所有者。',
  })
  @ApiOkResponse({ description: '变更结果', type: EnterpriseUserStatusView })
  @Post('users/:id/status')
  @HttpCode(200)
  async setStatus(
    @CurrentEnterprise() ent: EnterpriseEntity,
    @Param('id') id: string,
    @Body() dto: EnterpriseUserStatusDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<EnterpriseUserStatusView> {
    const result = await this.enterprise.setEnterpriseUserStatus(String(ent.id), id, dto.status);
    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: dto.status === 1 ? AuditAction.USER_DISABLE : AuditAction.USER_ENABLE,
      target: `user:${id}`,
      detail: { enterprise_id: String(ent.id), status: dto.status },
      ip: this.audit.ipOf(request),
    });
    return result;
  }
}
