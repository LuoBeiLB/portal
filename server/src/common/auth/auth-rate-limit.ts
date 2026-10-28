import { Injectable } from '@nestjs/common';
import { Request } from 'express';

import { BizException, ErrorCode } from '../error/error-code';
import { RateLimiterService } from '../redis/rate-limiter.service';
import { clientIpOf } from '../util/request.util';

/**
 * 登录/注册等公开入口的限流。
 *
 * ## 密钥（限流键）为什么要带 `subject`
 *
 * 早先只按 **IP** 计数。单人使用没问题，但**产品侧服务端代理登录**时会出事：
 * 云手机/云电脑/云存储都是"用户填账号密码 → 产品后端 → 门户登录"，
 * 于是**该产品的全部用户共用产品服务器那一个出口 IP**。
 * 生产默认 10 次/分钟/IP ⇒ 整个产品每分钟只能登 10 个人，早高峰必挂，
 * 而且现象是"随机一部分人登不进"，极难排查。
 *
 * 带上 `subject`（登录时是 username）后，每个「IP + 账号」一个独立桶：
 *
 * - 共享出口 IP 的不同账号互不影响 ✅
 * - 同一个账号仍然被限流（防爆破）✅
 * - 代价：不再有"单 IP 总量"上限，所以**暴力扫号**的防护只到"每账号每 IP 10 次/分"。
 *   这属于有意取舍——产品代理登录场景下，IP 维度已失去区分力。
 */
@Injectable()
export class AuthRateLimit {
  constructor(private readonly limiter: RateLimiterService) {}

  async enforce(
    request: Request,
    scope: string,
    windowSeconds: number,
    max: number,
    subject?: string,
  ): Promise<void> {
    const ip = clientIpOf(request);
    const key = subject ? `${scope}:${subject}:${ip}` : `${scope}:${ip}`;
    const result = await this.limiter.hit(key, windowSeconds, max);
    if (!result.allowed) {
      throw new BizException(ErrorCode.PARAM_INVALID, '请求过于频繁，请稍后再试', {
        retry_after: result.retryAfterSeconds,
      });
    }
  }
}
