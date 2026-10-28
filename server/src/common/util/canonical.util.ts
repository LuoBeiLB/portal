import { createHash } from 'node:crypto';

/**
 * 服务凭据的请求绑定工具（`docs/27` §3.3）。
 *
 * 抽成 util 的理由：**签名方与验签方必须用完全相同的算法**。
 * 门户自己既要签（出站）、又要验（入站），两处如果各写一份，
 * 任何一处改动都会造成"自己签的、自己验不过"。
 */
export function stripApiPrefix(path: string): string {
  return path.replace(/^\/api(?=\/)/, '');
}

/**
 * query 规范化：按 key 字典序升序 → `encodeURIComponent` → `&` 连接；无 query 返回空串。
 *
 * 入参可以是完整 URL，也可以是裸 query 串（`a=1&b=2`）。
 */
export function canonicalQuery(urlOrQuery: string): string {
  /*
   * 入参可能是 URL（`/api/x?a=1`）也可能是裸 query（`a=1`）。
   * 判定方式：以 `/` 开头或含 `://` 的当 URL 处理——URL 没有 query 时结果是空串，
   * 否则会把 `/x` 这种路径误当成 `/x=` 的 query（曾经的 bug）。
   */
  const isUrl = urlOrQuery.startsWith('/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrQuery);
  const raw = isUrl
    ? urlOrQuery.includes('?')
      ? urlOrQuery.slice(urlOrQuery.indexOf('?') + 1)
      : ''
    : urlOrQuery;
  if (!raw) return '';
  const params = new URLSearchParams(raw);
  return [...params.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** body 摘要：对**原始字节**算 SHA-256（小写 hex）。传字符串时按 utf8 编码 */
export function bodySha256(body: Buffer | string | undefined): string | undefined {
  if (body === undefined) return undefined;
  const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  if (buffer.length === 0) return undefined;
  return createHash('sha256').update(buffer).digest('hex');
}