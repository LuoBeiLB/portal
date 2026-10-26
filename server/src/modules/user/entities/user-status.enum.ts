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

/**
 * 账号性质（2026-10-19 新增，`u_user.user_type`）。
 *
 * 与 `role` **正交**：`role` 决定"能不能进门户管理端"，`user_type` 决定"账号是什么性质"。
 *
 * 为什么需要它：企业员工**不能自助充值、不能下单**（额度由企业统一采购），
 * 而个人用户正好相反。靠角色判断是不行的——企业管理员也只是普通用户。
 *
 * ⚠️ 注册接口把本字段**写死为 PERSONAL**，绝不从请求体接受，
 * 否则任何人注册时传个 1 就能绕过"企业员工不能充值"的限制。
 */
export enum UserType {
  /** 个人用户：可自助充值、可下单 */
  PERSONAL = 0,
  /** 企业员工：余额恒 0，不能充值/下单；必须有所属企业 */
  ENTERPRISE_STAFF = 1,
}

export enum WalletStatus {
  NORMAL = 0,
  /** 冻结：产品扣费返回 3002，不可重试 */
  FROZEN = 1,
}
