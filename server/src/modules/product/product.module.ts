import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ProductSyncLogEntity } from './entities/product-sync-log.entity';
import { ProductEntity } from './entities/product.entity';
import { ProductClient } from './product.client';
import { ProductSyncService } from './product-sync.service';

/**
 * 商品目录模块（契约 §5.1）。
 * `ProductClient` 是门户外呼产品的唯一出口，被商品同步与开通 worker 复用。
 */
@Module({
  imports: [HttpModule.register({ maxRedirects: 0 }), TypeOrmModule.forFeature([ProductEntity, ProductSyncLogEntity])],
  providers: [ProductClient, ProductSyncService],
  exports: [ProductClient, ProductSyncService],
})
export class ProductModule {}
