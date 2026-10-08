import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';

import { AdminGuard } from '../../common/admin.guard';
import { CurrentUser, AuthUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { RawResponse } from '../../common/raw-response.decorator';
import { ConfirmRechargeDto, RechargeQueryDto, RechargeApplyDto, TransactionQueryDto } from './dto/wallet.dto';
import { WalletService } from './wallet.service';

/** 契约 §3 钱包接口（用户端，Bearer 鉴权） */
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  /** §3.1 余额 */
  @Get('balance')
  async balance(@CurrentUser() user: AuthUser): Promise<Record<string, unknown>> {
    return { ...(await this.wallet.balance(user.id)) };
  }

  /** §3.2 流水（分页，type / product_code 可选） */
  @Get('transactions')
  async transactions(
    @CurrentUser() user: AuthUser,
    @Query() query: TransactionQueryDto,
  ): Promise<Record<string, unknown>> {
    return { ...(await this.wallet.listTransactions(user.id, query)) };
  }

  /** §3.3 充值申请（人工核销） */
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
@Public()
@UseGuards(AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly wallet: WalletService) {}

  /** §6 充值核销队列 `GET /admin/recharges?status=0` */
  @Get('recharges')
  async listRecharges(@Query() query: RechargeQueryDto): Promise<Record<string, unknown>> {
    return { ...(await this.wallet.listRecharges(query.status, query.page, query.effectiveSize)) };
  }

  /** §6.2 确认到账 / 驳回：body `reject: true` 则驳回 */
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
  @RawResponse()
  @Get('transactions/export')
  async exportTransactions(
    @Query() query: TransactionQueryDto,
    @Res() response: Response,
  ): Promise<void> {
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
