import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { ErrorCode } from './error-code';

export interface PortalResponse<T> {
  code: number;
  message: string;
  data: T;
}

/** handler 可用它显式指定业务码（例如幂等重复 3003） */
export interface BizCodePayload<T> {
  __bizCode: number;
  __bizMessage?: string;
  data: T;
}

export function withBizCode<T>(code: number, data: T, message?: string): BizCodePayload<T> {
  return { __bizCode: code, __bizMessage: message, data };
}

/**
 * 统一响应包装（契约 §0.2）：
 *   { "code": 0, "message": "ok", "data": { } }
 * 所有接口 HTTP 状态码均为 200，业务结果看 body。
 * 分页接口请在 handler 里自行返回 `{ list, total, page, size }`。
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, PortalResponse<T | null>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<PortalResponse<T | null>> {
    return next.handle().pipe(
      map((payload) => {
        if (payload !== null && typeof payload === 'object' && '__bizCode' in (payload as object)) {
          const { __bizCode, __bizMessage, data } = payload as unknown as BizCodePayload<T>;
          return { code: __bizCode, message: __bizMessage ?? 'ok', data };
        }
        return { code: ErrorCode.OK, message: 'ok', data: (payload ?? null) as T };
      }),
    );
  }
}
