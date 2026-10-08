import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WalletModule } from '../wallet/wallet.module';
import { OrderItemEntity } from './entities/order-item.entity';
import { OrderEntity } from './entities/order.entity';
import { ProvisionJobEntity } from './entities/provision-job.entity';
import { OrderService } from './order.service';
import { ShopController } from './order.controller';
import { ProductEntity } from '../product/entities/product.entity';
import { ProductSyncLogEntity } from '../product/entities/product-sync-log.entity';
import { ProductClient } from '../product/product.client';
import { ProductModule } from '../product/product.module';
import { ProvisionWorker } from './provision.worker';

/**
 * 商城与开通模块（契约 §2 用户端 + §5 门户 → 产品）。
 *
 * - `ProductModule` 提供商品目录同步与商品查询
 * - `ProvisionWorker` 是后台任务，随模块启动自动开始轮询（@Interval）
 */
@Module({
  imports: [
    HttpModule.register({ maxRedirects: 0 }),
    TypeOrmModule.forFeature([OrderEntity, OrderItemEntity, ProvisionJobEntity, ProductEntity, ProductSyncLogEntity]),
    ProductModule,
    WalletModule,
  ],
  controllers: [ShopController],
  providers: [OrderService, ProductClient, ProvisionWorker],
  exports: [OrderService, ProvisionWorker, ProductClient],
})
export class OrderModule {}
