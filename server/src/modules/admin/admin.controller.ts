import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { AdminGuard } from '../../common/admin.guard';
import { AuthUser, CurrentUser } from '../../common/current-user.decorator';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import { AdminService } from './admin.service';
import {
  AdminTransactionQueryDto,
  AdminUserQueryDto,
  AuditLogQueryDto,
  CreateAdminDto,
  ResetPasswordDto,
  UserStatusDto,
} from './dto/admin.dto';

/**
 * 管理端（2026-10-10 起改用**管理员账号**鉴权，废弃静态 `X-Admin-Key`）。
 *
 * ⚠️ 这里**刻意不标 `@Public()`**：管理端必须经过全局 `JwtAuthGuard`，
 * 由它填充 `request.user`（含 `role`），`AdminGuard` 才能判断是不是管理员。
 * 早先标 `@Public()` 是为了绕过 JWT 直接比静态密钥——那也导致
 * "路径二（已登录用户校验角色）"成为永远走不到的死代码。
 *
 * 操作人一律取 `@CurrentUser()`（来自已验证的 JWT），**不接受前端自报**，
 * 这样审计日志里的"经办人"才可信。
 */
@ApiTags('管理端 admin')
@ApiBearerAuth('bearer')
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminPortalController {
  constructor(
    private readonly admin: AdminService,
    private readonly audit: AuditService,
  ) {}

  /** 登录态校验：前端登录页用它判断凭据是否有效，不必靠"随便调个业务接口看 1004" */
  @ApiOperation({
    summary: '校验管理端登录态（前端需求清单 P1）',
    description:
      '返回当前操作人与角色。**用于管理端登录页**：拿到 `code: 0` 即凭据有效。\n\n' +
      '非管理员调用返回 `1004`，未登录返回 `1002`。',
  })
  @Get('auth/verify')
  async verify(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    return { ...(await this.admin.verify({ id: user.id, username: user.username, role: user.role })) };
  }

  // ───────────────────────── 用户管理 ─────────────────────────

  @ApiOperation({
    summary: '用户查询列表（前端需求清单 P0）',
    description:
      '**只列普通用户**（管理员走 `/api/admin/admins`），避免在用户管理页误禁用管理员。\n\n' +
      '`keyword` 匹配用户名或手机号；`status` 可过滤。响应带余额与累计充值/消费，' +
      '`recharge_total_cents` / `consume_total_cents` 为 type=1 / type=2 的流水合计。',
  })
  @Get('users')
  async listUsers(@Query() query: AdminUserQueryDto): Promise<Record<string, unknown>> {
    return {
      ...(await this.admin.listUsers({
        page: query.page,
        size: query.effectiveSize,
        keyword: query.keyword,
        status: query.status,
      })),
    };
  }

  @ApiOperation({
    summary: '启用 / 禁用用户（前端需求清单 P0，disable+enable 合并）',
    description:
      '`status: 1` 禁用：置状态 + **冻结钱包** + **吊销全部 refresh**（强制下线）。\n\n' +
      '`status: 0` 恢复：置状态 + 解冻钱包，**不恢复登录态**，用户需重新登录。\n\n' +
      '错误：`4001` 用户不存在 · `4002` 状态未变化 · `1004` 目标是管理员（请走管理员接口）。\n\n' +
      '操作会写入审计日志（`user_disable` / `user_enable`），操作人取自当前登录的管理员。',
  })
  @HttpCode(200)
  @ApiOkResponse({ description: '契约 §0.2：业务响应统一 HTTP 200，结果看 body 的 code' })
  @Post('users/:id/status')
  async setUserStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UserStatusDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    const result = await this.admin.setUserStatus(id, body.status, body.reason);

    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: body.status === 1 ? AuditAction.USER_DISABLE : AuditAction.USER_ENABLE,
      target: `user:${id}`,
      detail: { status: result.status, reason: body.reason ?? null },
      ip: this.audit.ipOf(request),
    });

    return { ...result };
  }

  // ───────────────────────── 流水 ─────────────────────────

  @ApiOperation({
    summary: '交易流水列表（前端需求清单 P0）',
    description:
      '比用户端的流水接口多 `username` 与 `user_balance_cents`（便于核对）。\n\n' +
      '支持 `type` / `product_code` / `user_id` / `keyword`（用户名或手机号）以及\n' +
      '`start_date` / `end_date`（**UTC 自然日，含当日**）过滤 —— 管理端最常用的"查某天的流水"。',
  })
  @Get('transactions')
  async listTransactions(@Query() query: AdminTransactionQueryDto): Promise<Record<string, unknown>> {
    return {
      ...(await this.admin.listTransactions({
        page: query.page,
        size: query.effectiveSize,
        type: query.type,
        product_code: query.product_code,
        user_id: query.user_id,
        keyword: query.keyword,
        start_date: query.start_date,
        end_date: query.end_date,
      })),
    };
  }

  // ───────────────────────── 操作日志 ─────────────────────────

  @ApiOperation({
    summary: '操作日志列表（前端需求清单 P0）',
    description:
      '记录**写操作与数据导出**（读接口不记，否则日志会被列表查询刷满）。\n\n' +
      '`operator` 来自**已验证的 JWT**，不是前端自报 —— 这是本表可信的前提。\n\n' +
      '⚠️ 能力边界：能追到"哪个管理员在什么时候做了什么"，但**前提是每个管理员用自己的账号**。\n' +
      '如果多人共用一个账号，审计就退回不可追溯。',
  })
  @Get('audit-logs')
  async listAuditLogs(@Query() query: AuditLogQueryDto): Promise<Record<string, unknown>> {
    return {
      ...(await this.audit.list({
        page: query.page,
        size: query.effectiveSize,
        operator: query.operator,
        action: query.action,
        target: query.target,
        start_date: query.start_date,
        end_date: query.end_date,
      })),
    };
  }

  // ───────────────────────── 管理员账号 ─────────────────────────

  @ApiOperation({
    summary: '管理员列表',
    description: '列出全部管理员（含已禁用）。首个管理员由环境变量 bootstrap 创建，其余用本组接口创建。',
  })
  @Get('admins')
  async listAdmins(): Promise<Record<string, unknown>> {
    return { ...(await this.admin.listAdmins()) };
  }

  @ApiOperation({
    summary: '创建管理员',
    description:
      '创建 `role=admin` 的账号（复用普通用户体系，直接用它登录 `/api/auth/login`）。\n\n' +
      '错误：`2001` 用户名已存在 · `2002` 手机号已注册 · `1001` 参数校验失败。\n\n' +
      '操作写入审计日志。',
  })
  @HttpCode(200)
  @ApiOkResponse({ description: '契约 §0.2：业务响应统一 HTTP 200，结果看 body 的 code' })
  @Post('admins')
  async createAdmin(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateAdminDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    const created = await this.admin.createAdmin({
      username: body.username,
      password: body.password,
      phone: body.phone,
    });

    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: AuditAction.ADMIN_CREATE,
      target: `admin:${created.id}`,
      detail: { username: created.username, phone: body.phone ?? null },
      ip: this.audit.ipOf(request),
    });

    return { ...created };
  }

  @ApiOperation({
    summary: '启用 / 禁用管理员',
    description:
      '两道守卫防止把自己锁在门外：**不能禁用自己**、**不能禁用最后一个可用管理员**。\n\n' +
      '禁用会吊销该管理员的全部 refresh 会话（强制下线）。\n\n' +
      '错误：`4001` 管理员不存在 · `4002` 状态未变化 · `1004` 违反上述守卫。',
  })
  @HttpCode(200)
  @ApiOkResponse({ description: '契约 §0.2：业务响应统一 HTTP 200，结果看 body 的 code' })
  @Post('admins/:id/status')
  async setAdminStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: UserStatusDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    const result = await this.admin.setAdminStatus(user.id, id, body.status);

    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: body.status === 1 ? AuditAction.ADMIN_DISABLE : AuditAction.ADMIN_ENABLE,
      target: `admin:${id}`,
      detail: { status: result.status, revoked_sessions: result.revoked_sessions, reason: body.reason ?? null },
      ip: this.audit.ipOf(request),
    });

    return { ...result };
  }

  @ApiOperation({
    summary: '重置某个管理员的密码',
    description:
      '管理员重置**他人**密码；改自己的密码请用 `POST /api/auth/password`。\n\n' +
      '重置后会吊销该管理员的全部 refresh 会话（强制重新登录）。\n\n' +
      '错误：`4001` 管理员不存在 · `1001` 目标是自己（请用改密接口）。',
  })
  @HttpCode(200)
  @ApiOkResponse({ description: '契约 §0.2：业务响应统一 HTTP 200，结果看 body 的 code' })
  @Post('admins/:id/password')
  async resetAdminPassword(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: ResetPasswordDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    const result = await this.admin.resetAdminPassword(user.id, id, body.new_password);

    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: AuditAction.ADMIN_PASSWORD_RESET,
      target: `admin:${id}`,
      detail: { revoked_sessions: result.revoked_sessions },
      ip: this.audit.ipOf(request),
    });

    return { ...result };
  }
}
