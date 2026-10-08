export enum UserStatus {
  /** 正常 */
  NORMAL = 0,
  /** 禁用（同时冻结钱包并吊销 refresh，契约 §6） */
  DISABLED = 1,
}

export enum WalletStatus {
  NORMAL = 0,
  /** 冻结：产品扣费返回 3002，不可重试 */
  FROZEN = 1,
}
