import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RechargeApplyEntity } from './entities/recharge-apply.entity';
import { TransactionEntity } from './entities/transaction.entity';
import { WalletEntity } from './entities/wallet.entity';
import { WalletLedgerService } from './wallet-ledger.service';
import { AdminController, WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * 钱包模块（契约 §3 用户端 + §6 管理端）。
 * 资金操作集中在 WalletLedgerService，供内网计费接口（round 3）与充值核销复用。
 */
@Module({
  imports: [TypeOrmModule.forFeature([WalletEntity, TransactionEntity, RechargeApplyEntity])],
  controllers: [WalletController, AdminController],
  providers: [WalletService, WalletLedgerService],
  exports: [WalletService, WalletLedgerService],
})
export class WalletModule {}
