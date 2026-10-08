/**
 * 全局错误码（契约 §0.6）。
 * 产品侧集成要求：**只依据 code 判断，不要解析 message 文本**。
 */
export enum ErrorCode {
  OK = 0,

  // 通用
  PARAM_INVALID = 1001,
  UNAUTHENTICATED = 1002,
  TOKEN_EXPIRED = 1003,
  FORBIDDEN = 1004,

  // 账号
  USERNAME_EXISTS = 2001,
  PHONE_REGISTERED = 2002,
  BAD_CREDENTIALS = 2003,
  ACCOUNT_DISABLED = 2004,

  // 钱包
  INSUFFICIENT_BALANCE = 3001,
  WALLET_FROZEN = 3002,
  IDEMPOTENT_REPEATED = 3003,
  REFUND_EXCEEDS_ORIGINAL = 3004,
  ORIGIN_BILL_NOT_FOUND = 3005,

  // 订单/商品
  ORDER_NOT_FOUND = 4001,
  ORDER_STATUS_NOT_ALLOWED = 4002,
  PRODUCT_NOT_FOUND = 4003,
  STOCK_NOT_ENOUGH = 4004,

  // 系统
  INTERNAL_ERROR = 5001,
}

/** code -> 默认提示（仅用于日志/调试，前端不得依赖文案） */
export const ERROR_MESSAGES: Record<number, string> = {
  [ErrorCode.OK]: 'ok',
  [ErrorCode.PARAM_INVALID]: '参数校验失败',
  [ErrorCode.UNAUTHENTICATED]: '未认证或 token 无效',
  [ErrorCode.TOKEN_EXPIRED]: 'token 已过期',
  [ErrorCode.FORBIDDEN]: '无权限',
  [ErrorCode.USERNAME_EXISTS]: '用户名已存在',
  [ErrorCode.PHONE_REGISTERED]: '手机号已注册',
  [ErrorCode.BAD_CREDENTIALS]: '账号或密码错误',
  [ErrorCode.ACCOUNT_DISABLED]: '账号被禁用',
  [ErrorCode.INSUFFICIENT_BALANCE]: '余额不足',
  [ErrorCode.WALLET_FROZEN]: '钱包冻结',
  [ErrorCode.IDEMPOTENT_REPEATED]: '幂等重复（非错误）',
  [ErrorCode.REFUND_EXCEEDS_ORIGINAL]: '退款金额超出原账单可退余额',
  [ErrorCode.ORIGIN_BILL_NOT_FOUND]: '原 bill_no 不存在',
  [ErrorCode.ORDER_NOT_FOUND]: '订单不存在',
  [ErrorCode.ORDER_STATUS_NOT_ALLOWED]: '订单状态不允许该操作',
  [ErrorCode.PRODUCT_NOT_FOUND]: '商品不存在或已下架',
  [ErrorCode.STOCK_NOT_ENOUGH]: '库存不足',
  [ErrorCode.INTERNAL_ERROR]: '内部错误',
};

/** 业务异常：抛出后由全局过滤器统一转成 `{code,message,data}`，HTTP 仍为 200 */
export class BizException extends Error {
  readonly code: ErrorCode;
  readonly data?: unknown;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message?: string, data?: unknown, httpStatus = 200) {
    super(message ?? ERROR_MESSAGES[code] ?? 'error');
    this.name = 'BizException';
    this.code = code;
    this.data = data;
    this.httpStatus = httpStatus;
  }
}
