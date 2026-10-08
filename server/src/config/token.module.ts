import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { PortalConfigService } from './portal-config.service';

/**
 * JWT 签发模块（契约 §0.3）：
 * - 只用于**签发**，算法固定 RS256、issuer=cloud-portal、header 带 kid；
 * - 验签在各消费者处显式指定公钥（JwtAuthGuard / 产品侧各自的 JWKS 缓存）；
 * - 私钥缺失时**启动即失败**，避免带着坏配置上线（健康的失败要好过静默的不可用）。
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [PortalConfigService],
      useFactory: (config: PortalConfigService) => {
        if (!config.jwt.current.privateKey) {
          throw new Error(
            'JWT 私钥未配置：请先执行 `npm run keys:generate`，并设置 JWT_PRIVATE_KEY_FILE 或 JWT_PRIVATE_KEY',
          );
        }
        return {
          privateKey: config.jwt.current.privateKey,
          publicKey: config.jwt.current.publicKey || undefined,
          signOptions: {
            algorithm: 'RS256' as const,
            issuer: config.jwt.issuer,
            keyid: config.jwt.current.kid,
          },
          verifyOptions: {
            algorithms: ['RS256'] as const,
            issuer: config.jwt.issuer,
          },
        };
      },
    }),
  ],
  exports: [JwtModule],
})
export class TokenModule {}
