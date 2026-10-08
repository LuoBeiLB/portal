import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** UUIDv7（时间有序）：门户用户主键用 CHAR(36) 存储，JWT 的 sub 即此值 */
export function uuidv7(): string {
  const timestamp = Date.now();
  const random = randomBytes(10);
  const bytes = Buffer.alloc(16);

  // 48 位毫秒时间戳
  bytes.writeUIntBE(timestamp, 0, 6);
  random.copy(bytes, 6);

  // version = 7
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  // variant = 10xx
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 随机不透明令牌（refresh token），32 字节 → 64 位十六进制 */
export function randomToken(): string {
  return randomBytes(32).toString('hex');
}

/** 令牌摘要：Redis 只存摘要，即便 Redis 泄露也无法直接冒用 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 常量时间比较，避免时序侧信道（仅用于密钥等短字符串） */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export { randomUUID };
