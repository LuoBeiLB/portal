import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserEntity } from '../user/entities/user.entity';
import { WalletModule } from '../wallet/wallet.module';
import { InternalWalletController } from './internal-wallet.controller';

/**
 * 内网接口模块（契约 §4 与 §5 的门户侧）。
 *
 * ⚠️ 这些接口靠 X-Internal-Key 鉴权，**必须确保不对公网暴露**（防火墙/nginx 层控制）。
 * §5（门户 → 产品：商品目录拉取、开通）在 round 3 加入。
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserEntity]), WalletModule],
  controllers: [InternalWalletController],
})
export class InternalModule {}
