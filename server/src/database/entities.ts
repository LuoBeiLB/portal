import { OrderItemEntity } from '../modules/order/entities/order-item.entity';
import { OrderEntity } from '../modules/order/entities/order.entity';
import { ProvisionJobEntity } from '../modules/order/entities/provision-job.entity';
import { ProductSyncLogEntity } from '../modules/product/entities/product-sync-log.entity';
import { ProductEntity } from '../modules/product/entities/product.entity';
import { ProductBillReportEntity } from '../modules/reconciliation/entities/product-bill-report.entity';
import { ReconciliationEntity } from '../modules/reconciliation/entities/reconciliation.entity';
import { UserEntity } from '../modules/user/entities/user.entity';
import { RechargeApplyEntity } from '../modules/wallet/entities/recharge-apply.entity';
import { TransactionEntity } from '../modules/wallet/entities/transaction.entity';
import { WalletEntity } from '../modules/wallet/entities/wallet.entity';

/** 门户库全部实体（迁移与 TypeORM 连接共用同一份清单，避免漏表） */
export const PORTAL_ENTITIES = [
  UserEntity,
  WalletEntity,
  TransactionEntity,
  RechargeApplyEntity,
  ProductEntity,
  ProductSyncLogEntity,
  OrderEntity,
  OrderItemEntity,
  ProvisionJobEntity,
  ProductBillReportEntity,
  ReconciliationEntity,
];

export {
  UserEntity,
  WalletEntity,
  TransactionEntity,
  RechargeApplyEntity,
  ProductEntity,
  ProductSyncLogEntity,
  OrderEntity,
  OrderItemEntity,
  ProvisionJobEntity,
  ProductBillReportEntity,
  ReconciliationEntity,
};
