import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditModule } from '../audit/audit.module';
import { RechargeApplyEntity } from './entities/recharge-apply.entity';
import { TransactionEntity } from './entities/transaction.entity';
import { WalletEntity } from './entities/wallet.entity';
import { WalletLedgerService } from './wallet-ledger.service';
import { AdminController, WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * 钱包模块（契约 §3 用户端 + §6 管理端）。
 * 资金操作集中在 WalletLedgerService，供内网计费接口与充值核销复用。
 *
 * `AuditModule`（全局）提供 `AuditService`：核销充值、驳回、导出流水都要写审计日志。
 */
@Module({
  imports: [TypeOrmModule.forFeature([WalletEntity, TransactionEntity, RechargeApplyEntity]), AuditModule],
  controllers: [WalletController, AdminController],
  providers: [WalletService, WalletLedgerService],
  exports: [WalletService, WalletLedgerService],
})
export class WalletModule {}
