import { randomToken, safeEqual, sha256Hex, uuidv7 } from './crypto.util';

describe('crypto.util', () => {
  it('uuidv7 生成 36 位、版本位 7、variant 位合规', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).toHaveLength(36);
  });

  it('uuidv7 时间有序：后生成的字典序不小于先生成的', async () => {
    const first = uuidv7();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = uuidv7();
    expect(second > first).toBe(true);
  });

  it('refresh token 是 64 位十六进制且每次不同', () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('sha256Hex 稳定且不可逆推', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abc')).toHaveLength(64);
  });

  it('safeEqual：相同为真，长度不同或内容不同为假', () => {
    expect(safeEqual('key-123', 'key-123')).toBe(true);
    expect(safeEqual('key-123', 'key-124')).toBe(false);
    expect(safeEqual('key-123', 'key-1234')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
