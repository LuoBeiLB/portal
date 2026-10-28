import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TokenModule } from '../../config/token.module';
import { ServiceKeyEntity } from './entities/service-key.entity';
import { ServiceKeyService } from './service-key.service';
import { ServiceTokenService } from './service-token.service';

/**
 * 服务凭据模块（`docs/27`）：公钥的加载/缓存/查询 + 出站凭据签发。
 *
 * 被四处使用：
 * - `AuthModule`：JWKS 端点从这里取门户公钥
 * - `InternalModule` / `ReconciliationModule`：内网入站守卫验产品签名
 * - `ProductModule` / `OrderModule`：出站调用前签服务凭据
 *
 * ## 为什么标 `@Global()`
 *
 * 内网入站守卫（`InternalServiceAuthGuard`）被多个模块的控制器用 `@UseGuards()` 引用，
 * Nest 会在**每个**这样的模块上下文里实例化它，要求 `ServiceKeyService` 在该上下文可解析。
 * 逐个模块 import 极易漏（漏了就是启动期 DI 报错，且报错信息指向守卫而不是漏 import 的模块）。
 *
 * 这是基础设施型模块（类似 `RedisModule`），全局注册收益大于显式依赖的成本。
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([ServiceKeyEntity]), TokenModule],
  providers: [ServiceKeyService, ServiceTokenService],
  exports: [ServiceKeyService, ServiceTokenService],
})
export class ServiceKeyModule {}