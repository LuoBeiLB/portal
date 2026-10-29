import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { InternalServiceAuthGuard } from '../../common/auth/internal-service-auth.guard';
import { EnterpriseEntity } from '../enterprise/entities/enterprise.entity';
import { UserEntity } from '../user/entities/user.entity';
import { ServiceKeyModule } from '../service-key/service-key.module';
import { OrderEntity } from '../order/entities/order.entity';
import { OrderModule } from '../order/order.module';
import { WalletModule } from '../wallet/wallet.module';
import { InternalEnterpriseAccountController } from './internal-enterprise.controller';
import { InternalOrderController } from './internal-order.controller';
import { InternalOrderService } from './internal-order.service';
import { InternalEnterpriseListController } from './internal-enterprise-list.controller';
import { InternalWalletController } from './internal-wallet.controller';

/**
 * 内网接口模块（契约 §4 与 §5 的门户侧）。
 *
 * ⚠️ 这些接口靠 **RS256 服务凭据**鉴权（`docs/27`），仍**必须确保不对公网暴露**（防火墙/nginx 层控制）。
 * §5（门户 → 产品：商品目录拉取、开通）是**出站调用**，实现在 ProductClient 里，不在本模块。
 *
 * 2026-10-19 新增 `InternalEnterpriseAccountController`：给产品侧拉某企业的账号池
 * （`docs/24` §1.2）。它需要 `EnterpriseEntity` 仓储来校验企业是否 active。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, EnterpriseEntity, OrderEntity]),
    WalletModule,
    ServiceKeyModule,
    /* 服务端下单要复用 OrderService.create/pay，不能把下单逻辑复制一份 */
    OrderModule,
  ],
  controllers: [
    InternalWalletController,
    InternalEnterpriseAccountController,
    InternalEnterpriseListController,
    InternalOrderController,
  ],
  providers: [InternalOrderService, InternalServiceAuthGuard],
})
export class InternalModule {}
