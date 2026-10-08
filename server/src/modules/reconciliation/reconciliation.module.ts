import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrderModule } from '../order/order.module';
import { TransactionEntity } from '../wallet/entities/transaction.entity';
import { ProductBillReportEntity } from './entities/product-bill-report.entity';
import { ReconciliationEntity } from './entities/reconciliation.entity';
import { AdminReconciliationController, InternalReconciliationController } from './reconciliation.controller';
import { ReconciliationService } from './reconciliation.service';

/**
 * 对账模块（契约 §6）。
 * 依赖 OrderModule 拿到 ProvisionWorker（排障要看开通任务堆积情况）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([TransactionEntity, ProductBillReportEntity, ReconciliationEntity]), OrderModule],
  controllers: [AdminReconciliationController, InternalReconciliationController],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
