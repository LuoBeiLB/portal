export enum UserStatus {
  /** 正常 */
  NORMAL = 0,
  /** 禁用（同时冻结钱包并吊销 refresh，契约 §6） */
  DISABLED = 1,
}

/**
 * 用户角色（2026-10-10 新增）。
 *
 * 管理员**不是另一张表**，就是 `role = 'admin'` 的普通用户：复用同一套登录、
 * argon2id 密码、JWT 与 refresh 机制。这样审计日志才能记到**具体是谁**操作的
 * （静态 X-Admin-Key 无法区分操作人，已废弃）。
 *
 * ⚠️ 注册接口必须把 role 写死为 `USER`，**绝不能从请求体接受**，否则任何人都能注册出管理员。
 */
export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
}

export enum WalletStatus {
  NORMAL = 0,
  /** 冻结：产品扣费返回 3002，不可重试 */
  FROZEN = 1,
}
