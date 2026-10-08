import { Request } from 'express';

/** 从 Authorization 头解析 Bearer token；方案名大小写不敏感 */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return null;
  return value.trim() || null;
}

/** 取客户端 IP：优先 X-Forwarded-For 首个地址（经 nginx），否则 socket 地址 */
export function clientIpOf(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (raw) {
    const first = raw.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
}
