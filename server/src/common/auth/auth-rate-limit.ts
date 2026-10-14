import { Injectable } from '@nestjs/common';
import { Request } from 'express';

import { BizException, ErrorCode } from '../error/error-code';
import { RateLimiterService } from '../redis/rate-limiter.service';
import { clientIpOf } from '../util/request.util';

/**
 * 登录/注册限流封装：`${scope}:${ip}` 双维度计数。
 * 超限抛 1001 并在 data 里带 retry_after，前端可提示「稍后再试」。
 */
@Injectable()
export class AuthRateLimit {
  constructor(private readonly limiter: RateLimiterService) {}

  async enforce(request: Request, scope: string, windowSeconds: number, max: number): Promise<void> {
    const result = await this.limiter.hit(`${scope}:${clientIpOf(request)}`, windowSeconds, max);
    if (!result.allowed) {
      throw new BizException(ErrorCode.PARAM_INVALID, '请求过于频繁，请稍后再试', {
        retry_after: result.retryAfterSeconds,
      });
    }
  }
}
