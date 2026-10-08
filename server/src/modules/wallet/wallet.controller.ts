import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';

import { AdminGuard } from '../../common/admin.guard';
import { CurrentUser, AuthUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { RawResponse } from '../../common/raw-response.decorator';
import { ConfirmRechargeDto, RechargeQueryDto, RechargeApplyDto, TransactionQueryDto } from './dto/wallet.dto';
import { WalletService } from './wallet.service';

/** 契约 §3 钱包接口（用户端，Bearer 鉴权） */
@ApiTags('钱包 wallet')
@ApiBearerAuth('bearer')
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  /** §3.1 余额 */
  @ApiOperation({
    summary: '查询余额（契约 §3.1）',
    description: '返回 `{ balance_cents, status }`。`balance_cents` 单位**分**；`status`：0 正常 / 1 冻结（冻结时不能支付）。',
  })
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
  @Post('recharge/apply')
  async applyRecharge(
    @CurrentUser() user: AuthUser,
    @Body() dto: RechargeApplyDto,
  ): Promise<Record<string, unknown>> {
    return this.wallet.applyRecharge(user.id, dto);
  }
}

/**
 * 契约 §6 管理端接口（一期用 X-Admin-Key，见 AdminGuard）。
 * 放在同一控制器便于对照契约章节，路由仍是 /admin/*。
 */
@ApiTags('管理端 admin')
@ApiSecurity('admin-key')
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly wallet: WalletService) {}

  /** §6 充值核销队列 `GET /admin/recharges?status=0` */
  @ApiOperation({
    summary: '充值核销队列（契约 §6）',
    description: '`?status=0` 只看待核销（0 待核销 / 1 已到账 / 2 驳回，缺省返回全部）。列表带 `username` / `phone` 便于核对。',
  })
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
      '`admin_id` 为审核人标识（一期由调用方传入）。',
  })
  @Post('recharges/:id/confirm')
  async confirm(
    @Param('id') id: string,
    @Body() body: ConfirmRechargeDto,
    @Query('admin_id') adminId?: string,
  ): Promise<Record<string, unknown>> {
    // 一期没有 role 列，审核人标识由调用方传入（X-Admin-Key 属系统级凭证）
    return this.wallet.confirmRecharge(id, adminId ?? 'admin', Boolean(body?.reject), body?.reason);
  }

  /** §6 流水导出（CSV）：管理端对账下载。标 @RawResponse() 避免被套成 JSON 壳 */
  @ApiOperation({
    summary: '流水导出 CSV（契约 §6）',
    description:
      '返回 `text/csv`（带 BOM，Excel 打开中文不乱码），**不是 JSON**，前端应直接触发下载而不是当接口数据解析。' +
      '默认导出最近 5000 行，支持 type / product_code 过滤。',
  })
  @RawResponse()
  @Get('transactions/export')
  async exportTransactions(@Query() query: TransactionQueryDto, @Res() response: Response): Promise<void> {
    // 复用分页查询，导出上限 5000 行；CSV 加 BOM 保证 Excel 打开中文不乱码
    const page = await this.wallet.listTransactionsByAdmin({
      page: 1,
      size: 5000,
      type: query.type,
      product_code: query.product_code,
    });
    const header = 'id,type,amount_cents,balance_after,product_code,bill_no,refund_of_bill_no,created_at';
    const lines = page.list.map((row) =>
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
    response.setHeader('Content-Disposition', `attachment; filename="transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
    response.send(`\uFEFF${[header, ...lines].join('\n')}`);
  }
}
