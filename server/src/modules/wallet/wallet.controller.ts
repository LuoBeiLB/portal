import { ApiBearerAuth, ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';

import { AdminGuard } from '../../common/admin.guard';
import { CurrentUser, AuthUser } from '../../common/current-user.decorator';
import { RawResponse } from '../../common/raw-response.decorator';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { AuditService } from '../audit/audit.service';
import {
  AdminRechargeListView,
  MyRechargeListView,
  RechargeConfirmResultView,
  TransactionListView,
} from '../order/dto/order.vo';
import {
  ConfirmRechargeDto,
  ExportTransactionQueryDto,
  MyRechargeQueryDto,
  RechargeQueryDto,
  RechargeApplyDto,
  TransactionQueryDto,
} from './dto/wallet.dto';
import { WalletService } from './wallet.service';
import { BalanceView, DeductView, RechargeApplyResultView, RefundView } from '../../common/dto/common.vo';

/** 契约 §3 钱包接口（用户端，Bearer 鉴权） */
@ApiTags('钱包 wallet')
@ApiBearerAuth('bearer')
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  /** §3.1 余额 */
  @ApiOperation({
    summary: '查询余额（契约 §3.1）',
    description:
      '返回 `{ balance_cents, status }`。`balance_cents` 单位**分**；`status`：0 正常 / 1 冻结（冻结时不能支付）。',
  })
  @ApiOkResponse({ description: '统一响应壳，data 为余额与钱包状态', type: BalanceView })
  @Get('balance')
  async balance(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    return { ...(await this.wallet.balance(user.id)) };
  }

  /** §3.2 流水（分页，type / product_code 可选） */
  @ApiOperation({
    summary: '资金流水（契约 §3.2）',
    description:
      '分页返回 `{ list, total, page, size }`，按时间倒序。`type`：1 充值 / 2 扣费 / 3 退款 / 4 调账。\n\n' +
      '`created_at` 为 **UTC**（如 `2026-10-05T02:00:00Z`），前端展示前必须转本地时区；`detail` 是产品传入的任意 JSON。',
  })
  @ApiOkResponse({ description: '统一响应壳，data 为流水列表 + 分页', type: TransactionListView })
  @Get('transactions')
  async transactions(
    @CurrentUser() user: AuthUser,
    @Query() query: TransactionQueryDto,
  ): Promise<Record<string, unknown>> {
    return { ...(await this.wallet.listTransactions(user.id, query)) };
  }

  /** §3.3 充值申请（人工核销） */
  @ApiOperation({
    summary: '提交充值申请（契约 §3.3）',
    description:
      '一期唯一入金通道：**提交申请 → 用户线下转账 → 管理员核销 → 余额到账**，不是即时到账。\n\n' +
      '金额 100 ~ 10,000,000 分。返回 `{ apply_id, status, notice }`，status：0 待核销 / 1 已到账 / 2 驳回。',
  })
  @HttpCode(200)
  @ApiOkResponse({ description: '统一响应壳，data 为申请单号与提示文案', type: RechargeApplyResultView })
  @Post('recharge/apply')
  async applyRecharge(@CurrentUser() user: AuthUser, @Body() dto: RechargeApplyDto): Promise<Record<string, unknown>> {
    return this.wallet.applyRecharge(user.id, dto);
  }

  /** 我的充值记录（2026-10-10 新增，前端需求单） */
  @ApiOperation({
    summary: '我的充值记录（契约外补充）',
    description:
      '返回**当前登录用户自己**的充值申请，按下单时间倒序。\n\n' +
      '为什么需要：充值走「申请 → 线下转账 → 管理员人工核销」，在此之前用户看不到核销进度。\n\n' +
      '`status`：`0` 待核销 / `1` 已到账 / `2` 驳回（可筛选，前端做成四个 tab）。\n\n' +
      '`balance_after` **仅在已到账时非空**（取自核销时写入的流水），其余状态为 `null`。\n' +
      '`reject_reason` **仅在驳回时非空**。\n\n' +
      '与管理端 `GET /api/admin/recharges` 参数一致，但不返回 `username` / `phone`（用户不需要看自己的）。',
  })
  @ApiOkResponse({ description: '统一响应壳，data 为充值记录 + 分页', type: MyRechargeListView })
  @Get('recharges')
  async listMyRecharges(
    @CurrentUser() user: AuthUser,
    @Query() query: MyRechargeQueryDto,
  ): Promise<Record<string, unknown>> {
    return {
      ...(await this.wallet.listMyRecharges(user.id, query.status, query.page, query.effectiveSize)),
    };
  }
}

/**
 * 契约 §6 管理端接口（充值核销队列 / 核销 / 流水导出）。
 *
 * 鉴权：**管理员账号**（`role=admin` 的 JWT），由 `AdminGuard` 校验。
 * 2026-10-10 起废弃静态 `X-Admin-Key`：它无法区分操作人，
 * `?admin_id=` 那种"经办人由前端自报"的设计让审计完全不可信。
 *
 * ⚠️ 刻意**不标 `@Public()`**：必须经过全局 `JwtAuthGuard` 填充 `request.user`，
 * `AdminGuard` 才能读到角色。
 */
@ApiTags('管理端 admin')
@ApiBearerAuth('bearer')
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
  ) {}

  /** §6 充值核销队列 `GET /admin/recharges?status=0` */
  @ApiOperation({
    summary: '充值核销队列（契约 §6）',
    description:
      '`?status=0` 只看待核销（0 待核销 / 1 已到账 / 2 驳回，缺省返回全部）。列表带 `username` / `phone` 便于核对。',
  })
  @ApiOkResponse({ description: '统一响应壳，data 为核销队列 + 分页', type: AdminRechargeListView })
  @Get('recharges')
  async listRecharges(@Query() query: RechargeQueryDto): Promise<Record<string, unknown>> {
    return { ...(await this.wallet.listRecharges(query.status, query.page, query.effectiveSize)) };
  }

  /** §6.2 确认到账 / 驳回：body `reject: true` 则驳回 */
  @ApiOperation({
    summary: '核销到账 / 驳回（契约 §6.2）',
    description:
      '条件更新抢占状态（`WHERE id=? AND status=0`）：**重复核销会被拒**，防止两个管理员同时点通过导致重复增额。\n\n' +
      '到账会加余额并写 type=1 流水；入金失败会自动退回待核销，不会留"已到账但没加钱"的悬空单。\n\n' +
      '**经办人取自当前登录的管理员**（不再接受 `?admin_id=` 传参，避免伪造）。操作写入审计日志。',
  })
  @HttpCode(200)
  @ApiOkResponse({ description: '统一响应壳，data 为核销结果', type: RechargeConfirmResultView })
  @Post('recharges/:id/confirm')
  async confirm(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: ConfirmRechargeDto,
    @Req() request: Request,
  ): Promise<Record<string, unknown>> {
    // 经办人来自已验证的 JWT，不再接受前端自报。
    // `reviewed_by` 列是 CHAR(36)，存的是管理员 user_id（不是用户名）。
    const result = await this.wallet.confirmRecharge(id, user.id, Boolean(body?.reject), body?.reason);

    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: body?.reject ? AuditAction.RECHARGE_REJECT : AuditAction.RECHARGE_CONFIRM,
      target: `apply:${id}`,
      detail: {
        reject: Boolean(body?.reject),
        reason: body?.reason ?? null,
        amount_cents: (result as { amount_cents?: number })?.amount_cents ?? null,
        balance_cents: (result as { balance_cents?: number })?.balance_cents ?? null,
      },
      ip: this.audit.ipOf(request),
    });

    return result;
  }

  /** §6 流水导出（CSV）：管理端对账下载。标 @RawResponse() 避免被套成 JSON 壳 */
  @ApiOperation({
    summary: '流水导出 CSV（契约 §6）',
    description:
      '返回 `text/csv`（带 BOM，Excel 打开中文不乱码），**不是 JSON**，前端应直接触发下载而不是当接口数据解析。\n\n' +
      '支持 `type` / `product_code` / `start_date` / `end_date`（UTC 自然日，含当日）过滤；\n' +
      '`limit` 控制最大行数（缺省 5000，上限 50000）—— 导出是数据外泄面，必须可界定范围。\n\n' +
      '导出动作会写入审计日志。',
  })
  @RawResponse()
  @ApiOkResponse({
    description: '**裸 CSV**（不套 {code,message,data} 壳），带 UTF-8 BOM，Content-Type: text/csv',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  @Get('transactions/export')
  async exportTransactions(
    @CurrentUser() user: AuthUser,
    @Query() query: ExportTransactionQueryDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const limit = Math.min(query.limit ?? 5000, 50_000);
    const rows = await this.wallet.listTransactionsForExport({
      limit,
      type: query.type,
      product_code: query.product_code,
      start_date: query.start_date,
      end_date: query.end_date,
    });

    const header = 'id,type,amount_cents,balance_after,product_code,bill_no,refund_of_bill_no,created_at';
    const lines = rows.map((row) =>
      [
        row.id,
        row.type,
        row.amount_cents,
        row.balance_after,
        row.product_code ?? '',
        row.bill_no,
        row.refund_of_bill_no ?? '',
        row.created_at,
      ].join(','),
    );

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="transactions-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    response.send(`\uFEFF${[header, ...lines].join('\n')}`);

    // 导出是数据外泄面，必须留痕（在响应发出后记录，不影响下载）
    await this.audit.record({
      operatorId: user.id,
      operator: user.username,
      action: AuditAction.TRANSACTION_EXPORT,
      target: 'transactions:csv',
      detail: {
        rows: rows.length,
        limit,
        type: query.type ?? null,
        product_code: query.product_code ?? null,
        start_date: query.start_date ?? null,
        end_date: query.end_date ?? null,
      },
      ip: this.audit.ipOf(request),
    });
  }
}
