import { ErrorCode } from './error-code';

/**
 * 契约 §0.6 错误码是**产品侧集成的唯一判据**（只依据 code 判断，不解析 message）。
 * 这里把契约原文的数值钉死在测试里：任何人改动枚举都会立刻红。
 */
describe('ErrorCode 必须与契约 §0.6 逐值一致', () => {
  it('通用段', () => {
    expect(ErrorCode.OK).toBe(0);
    expect(ErrorCode.PARAM_INVALID).toBe(1001);
    expect(ErrorCode.UNAUTHENTICATED).toBe(1002);
    expect(ErrorCode.TOKEN_EXPIRED).toBe(1003);
    expect(ErrorCode.FORBIDDEN).toBe(1004);
  });

  it('账号段', () => {
    expect(ErrorCode.USERNAME_EXISTS).toBe(2001);
    expect(ErrorCode.PHONE_REGISTERED).toBe(2002);
    expect(ErrorCode.BAD_CREDENTIALS).toBe(2003);
    expect(ErrorCode.ACCOUNT_DISABLED).toBe(2004);
  });

  it('钱包段（含「不重试」语义的三个码）', () => {
    expect(ErrorCode.INSUFFICIENT_BALANCE).toBe(3001);
    expect(ErrorCode.WALLET_FROZEN).toBe(3002);
    expect(ErrorCode.IDEMPOTENT_REPEATED).toBe(3003);
    expect(ErrorCode.REFUND_EXCEEDS_ORIGINAL).toBe(3004);
    expect(ErrorCode.ORIGIN_BILL_NOT_FOUND).toBe(3005);
  });

  it('订单/商品段', () => {
    expect(ErrorCode.ORDER_NOT_FOUND).toBe(4001);
    expect(ErrorCode.ORDER_STATUS_NOT_ALLOWED).toBe(4002);
    expect(ErrorCode.PRODUCT_NOT_FOUND).toBe(4003);
    expect(ErrorCode.STOCK_NOT_ENOUGH).toBe(4004);
  });

  it('系统段', () => {
    expect(ErrorCode.INTERNAL_ERROR).toBe(5001);
  });
});
