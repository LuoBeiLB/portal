import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthRateLimit } from '../../common/auth-rate-limit';
import { UserEntity } from '../user/entities/user.entity';
import { WalletEntity } from '../wallet/entities/wallet.entity';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwksController } from './jwks.controller';
import { JwksService } from './jwks.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * 认证模块（契约 §1）。
 * 一期不引入 role 列，`u_user` 即普通用户；管理端走 X-Admin-Key（见 AdminGuard）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, WalletEntity])],
  controllers: [AuthController, JwksController],
  // RateLimiterService 由全局 RateLimiterModule 提供（公开接口也要限流）
  providers: [AuthService, PasswordService, TokenService, JwksService, AuthRateLimit],
  exports: [AuthService, TokenService, PasswordService],
})
export class AuthModule {}
