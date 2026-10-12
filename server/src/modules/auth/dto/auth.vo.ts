import { ApiProperty } from '@nestjs/swagger';

/**
 * 认证接口（契约 §1）的响应结构。
 *
 * ## 为什么单独建这个文件（2026-10-12）
 *
 * 原先 `login` / `register` / `refresh` 三个接口都声明 `AuthTokenView`，但那个模型
 * **和实际返回对不上**：它声明了顶层 `id` / `username` / `phone` / `created_at`，
 * 而登录响应里这些字段在 `data.user` 下、顶层**没有**。
 *
 * 按项目接口纪律（`AGENTS.md`）"Swagger 必须有完整响应结构、且与实现一致"，
 * 这里按**实际返回**逐接口建模型。前端不用再"调一次把返回打印出来猜字段名"。
 *
 * ## 三个接口的真实形状
 *
 * | 接口 | data 顶层 | 用户信息位置 |
 * |---|---|---|
 * | 注册 §1.1 | `id` `username` `phone` `created_at` `access_token` `expires_in` `user` | `data.user` + 顶层四个档案字段 |
 * | 登录 §1.2 | `access_token` `expires_in` `user` | `data.user` |
 * | 刷新 §1.3 | `access_token` `expires_in` `user` | `data.user` |
 *
 * `refresh_token` 三个接口都**只走 HttpOnly Cookie**，不出现在 body 里
 * （所以这里没有这个字段 —— 前端读不到它，也不该读）。
 */

/** 令牌部分：三个认证接口共用 */
export class TokenPairView {
  @ApiProperty({
    description: '访问令牌（RS256，默认 2 小时）。放在 `Authorization: Bearer <token>`',
    example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6InBvcnRhbC0yMDI2LTEwIn0...',
  })
  access_token!: string;

  @ApiProperty({ description: '`access_token` 有效期（秒）', example: 7200 })
  expires_in!: number;
}

/**
 * 登录态用户摘要。
 *
 * `role` / `status` 是**给产品侧代理登录**用的（2026-10-12 新增）：
 * 产品拿用户填的账号密码调 `POST /api/auth/login`，成功后需要立刻知道
 * "这账号能不能用、是什么角色"，否则还得再调一次接口。
 */
export class LoginUserView {
  @ApiProperty({
    description: '门户用户 UUID。**产品侧据此建 `portal_user_map` 映射**',
    example: '01a11e65-3a34-7578-95a7-ebfdd8cd731c',
  })
  id!: string;

  @ApiProperty({ description: '用户名', example: 'luobo' })
  username!: string;

  @ApiProperty({
    description: '角色：`user` 普通用户 · `admin` 管理员（产品侧**不要**据此放行自家管理功能）',
    enum: ['user', 'admin'],
    example: 'user',
  })
  role!: string;

  @ApiProperty({
    description: '状态：`0` 正常 · `1` 禁用。**禁用账号登录时会直接返回 2004，走不到这里**；此字段用于二次确认',
    enum: [0, 1],
    example: 0,
  })
  status!: number;
}

/** 注册成功（契约 §1.1）：档案字段在顶层 + 令牌 + 用户摘要 */
export class RegisterResultView extends TokenPairView {
  @ApiProperty({
    description: '用户 UUID（与 `user.id` 同值，顶层便于直接取）',
    example: '01a11e65-3a34-7578-95a7-ebfdd8cd731c',
  })
  id!: string;

  @ApiProperty({ description: '用户名（与 `user.username` 同值）', example: 'luobo' })
  username!: string;

  @ApiProperty({ type: String, description: '手机号；未绑定时为 null', example: null, nullable: true })
  phone!: string | null;

  @ApiProperty({ description: '注册时间（墙上时间，直接展示、勿做时区转换）', example: '2026-09-30T03:00:00Z' })
  created_at!: string;

  @ApiProperty({ description: '登录态用户摘要（含 role / status）', type: LoginUserView })
  user!: LoginUserView;
}

/** 登录成功（契约 §1.2）：令牌 + 用户摘要 */
export class LoginResultView extends TokenPairView {
  @ApiProperty({ description: '登录态用户摘要（含 role / status）', type: LoginUserView })
  user!: LoginUserView;
}

/** 刷新成功（契约 §1.3）：新令牌 + 用户摘要 */
export class RefreshResultView extends TokenPairView {
  @ApiProperty({ description: '登录态用户摘要（含 role / status）', type: LoginUserView })
  user!: LoginUserView;
}
