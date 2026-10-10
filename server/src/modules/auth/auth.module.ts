import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthRateLimit } from '../../common/auth-rate-limit';
import { AuditModule } from '../audit/audit.module';
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
 *
 * 不引入独立的管理员表：管理员就是 `role='admin'` 的普通用户，复用本模块的
 * 登录 / argon2id 密码 / JWT / refresh。管理端鉴权与操作审计见 AdminModule。
 */
@Module({
  // AuditModule 提供 AuditService（改密码要写审计日志）；它是全局模块，不引入循环依赖
  imports: [TypeOrmModule.forFeature([UserEntity, WalletEntity]), AuditModule],
  controllers: [AuthController, JwksController],
  // RateLimiterService 由全局 RateLimiterModule 提供（公开接口也要限流）
  providers: [AuthService, PasswordService, TokenService, JwksService, AuthRateLimit],
  exports: [AuthService, TokenService, PasswordService],
})
export class AuthModule {}
