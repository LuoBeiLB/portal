import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { Request } from 'express';

import { PortalConfigService } from '../config/portal-config.service';
import { safeEqual } from './crypto.util';
import { BizException, ErrorCode } from './error-code';
import { INTERNAL_PRODUCT_KEY, InternalProduct } from './internal-product.types';

export const INTERNAL_KEY_HEADER = 'x-internal-key';

/**
 * 内网接口鉴权（契约 §0.3 / §4）：`X-Internal-Key: <密钥>`，每产品一码，**仅内网可用**。
 *
 * 本 Guard 做两件事：
 * 1. 校验密钥有效；
 * 2. **把密钥归属的产品身份挂到 `request.internalProduct`** —— 这是内网接口里唯一可信的
 *    产品身份来源。控制器必须用它，不能用请求体自报的 `product_code`。
 *
 * 为什么必须绑定身份：早先的实现只判断"密钥属于**某一个**已配置产品"（`some()`），
 * 于是任意一个产品都能在 body 里写别人的 `product_code`，把账记到别人头上、
 * 或退掉别人的账单。`some()` → `find()` 是这次修复的核心。
 *
 * 注意：本 Guard 只做密钥校验，**不保证内网**——必须由防火墙/nginx 保证该路径不被公网访问
 * （契约附录自检项：内网接口不对公网暴露）。
 */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalKeyGuard.name);

  constructor(private readonly config: PortalConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & Record<string, unknown>>();
    const provided = request.headers[INTERNAL_KEY_HEADER];
    const key = Array.isArray(provided) ? provided[0] : provided;
    if (!key) throw new BizException(ErrorCode.UNAUTHENTICATED);

    // 找出**所有**匹配的产品：命中多个说明多家配了同一把密钥，此时身份不可判定
    const matches = this.config.products.filter((item) => item.internalKey && safeEqual(item.internalKey, key));

    if (matches.length === 0) throw new BizException(ErrorCode.UNAUTHENTICATED);

    if (matches.length > 1) {
      // fail-closed：宁可拒绝也不猜。静默取第一个会让身份绑定形同虚设。
      this.logger.error(
        `内网密钥重复：${matches.map((item) => item.code).join(', ')} 配置了相同密钥，` +
          '无法判定调用方身份，已拒绝请求。请为每个产品配置**不同的**密钥。',
      );
      throw new BizException(ErrorCode.UNAUTHENTICATED, '密钥配置有误（多个产品使用了相同密钥），请联系平台侧');
    }

    const product: InternalProduct = { code: matches[0].code, key };
    request[INTERNAL_PRODUCT_KEY] = product;
    return true;
  }
}
