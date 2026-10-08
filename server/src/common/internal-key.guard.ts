import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

import { PortalConfigService } from '../config/portal-config.service';
import { safeEqual } from './crypto.util';
import { BizException, ErrorCode } from './error-code';

export const INTERNAL_KEY_HEADER = 'x-internal-key';

/**
 * 内网接口鉴权（契约 §0.3 / §4）：`X-Internal-Key: <密钥>`，每产品一码，**仅内网可用**。
 *
 * 注意：本 Guard 只做密钥校验，**不保证内网**——必须由防火墙/nginx 保证该路径不被公网访问
 * （契约附录自检项：内网接口不对公网暴露）。
 */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  constructor(private readonly config: PortalConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers[INTERNAL_KEY_HEADER];
    const key = Array.isArray(provided) ? provided[0] : provided;
    if (!key) throw new BizException(ErrorCode.UNAUTHENTICATED);

    const matched = this.config.products.some((item) => item.internalKey && safeEqual(item.internalKey, key));
    if (!matched) throw new BizException(ErrorCode.UNAUTHENTICATED);
    return true;
  }
}
