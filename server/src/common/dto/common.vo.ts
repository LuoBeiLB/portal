import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 通用响应模型（2026-10-10 新增）。
 *
 * 背景：C 组前端反馈 Swagger 里只有入参、没有响应结构，前端只能"调一次打印出来猜字段名"。
 * 这里补齐**跨模块复用**的响应壳与简单结果模型；领域模型放各自的 `*.vo.ts`。
 *
 * 命名约定：`*View` 表示"响应里的这个对象"，与入参 DTO 严格分开。
 */

/** 统一响应壳（契约 §0.2）：HTTP 恒为 200，成功与否看 `code` */
export class EnvelopeView {
  @ApiProperty({ description: '业务码：`0` 成功，其余见错误码表', example: 0 })
  code!: number;

  @ApiProperty({ description: '提示信息，成功时为 `ok`', example: 'ok' })
  message!: string;

  @ApiProperty({ description: '业务数据；失败时为错误上下文（如 `errors` / `retry_after`）', nullable: true })
  data!: unknown;
}

/** 操作类接口的通用返回（无实体可返回时用，前端只需判断 code） */
export class OkView {
  @ApiProperty({ description: '固定为 true；前端判断 `code === 0` 即可', example: true })
  ok!: boolean;
}

/** 契约 §3.1 余额 */
export class BalanceView {
  @ApiProperty({ description: '可用余额，单位：**分**（整数，不要用浮点运算）', example: 17000 })
  balance_cents!: number;

  @ApiProperty({ description: '钱包状态：`0` 正常 · `1` 冻结（冻结后不能扣费）', enum: [0, 1], example: 0 })
  status!: number;

  @ApiProperty({ description: '查询时间（UTC ISO 8601）', example: '2026-10-10T03:00:00Z' })
  updated_at!: string;
}

// 认证接口（注册/登录/刷新）的响应模型已移到 `modules/auth/dto/auth.vo.ts`。
// 原先这里的 `AuthTokenView` 声明了顶层 `id`/`username`/`phone`/`created_at`，
// 但登录响应里这些字段在 `data.user` 下、顶层并没有 —— 与实现不符，2026-10-12 删除。

/** 契约 §1.4 登出 / 修改密码等凭证类操作结果 */
export class CredentialResultView extends OkView {
  @ApiProperty({
    description: '本次被吊销的会话数（**改密码/被禁用后所有设备都要重新登录**）',
    example: 3,
  })
  revoked_sessions!: number;
}

/** 契约 §4.1 扣费响应 */
export class DeductView {
  @ApiProperty({ description: '固定为 true；重复扣费（幂等命中）也为 true', example: true })
  success!: boolean;

  @ApiProperty({ description: '扣费后余额，单位：分', example: 17000 })
  balance_cents!: number;

  @ApiProperty({ description: '幂等键回显（产品传入的 bill_no）', example: 'storage-20261010-0001' })
  bill_no!: string;
}

/** 契约 §4.2 退款响应 */
export class RefundView {
  @ApiProperty({ description: '固定为 true；重复退款（幂等命中）也为 true', example: true })
  success!: boolean;

  @ApiProperty({ description: '退款后余额，单位：分', example: 20000 })
  balance_cents!: number;
}

/** 契约 §3.3 充值申请响应 */
export class RechargeApplyResultView {
  @ApiProperty({ description: '申请单号（**string**）；查进度用 `GET /api/wallet/recharges`', example: '60' })
  apply_id!: string;

  @ApiProperty({ description: '状态：`0` 待核销（刚提交必然是 0）', enum: [0, 1, 2], example: 0 })
  status!: number;

  @ApiProperty({
    description: '给用户的提示文案（前端原样展示即可）',
    example: '请线下转账后等待管理员核销，到账后可在此页查看进度',
  })
  notice!: string;
}

/** 管理端流水导出参数回显（CSV 接口不套壳，此模型仅用于文档说明） */
export class ExportParamsView {
  @ApiPropertyOptional({ description: '起始日（含）', example: '2026-10-01' })
  start_date?: string;

  @ApiPropertyOptional({ description: '结束日（含）', example: '2026-10-10' })
  end_date?: string;

  @ApiPropertyOptional({ description: '最大导出条数', example: 5000 })
  limit?: number;
}

/** 通用分页壳（各列表接口 data 的基础结构） */
export class PageView {
  @ApiProperty({ description: '总条数（带筛选时为筛选后的数量）', example: 57 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  size!: number;
}

// ───────────────────────── 管理端（2026-10-10 新增）─────────────────────────

/** 管理端登录态校验响应 */
export class AdminVerifyView {
  @ApiProperty({ description: '固定为 true；非管理员会返回 `1004` 而不是此结构', example: true })
  ok!: boolean;

  @ApiProperty({ description: '当前管理员用户名（取自 JWT）', example: 'admin' })
  operator!: string;

  @ApiProperty({
    description: '当前管理员用户 ID（写入审计日志的 operator_id）',
    example: '01a123f4-7110-795a-8102-e03731eefd14',
  })
  operator_id!: string;

  @ApiProperty({ description: '固定为 `admin`', example: 'admin' })
  role!: string;

  @ApiProperty({ description: '服务端当前时间（UTC ISO 8601），前端可据此校准', example: '2026-10-10T03:10:30Z' })
  server_time!: string;
}

/** 管理端用户列表项（**只含普通用户**，管理员走 /admin/admins） */
export class AdminUserView {
  @ApiProperty({ description: '用户 UUID', example: '01a11e65-3a34-7578-95a7-ebfdd8cd731c' })
  id!: string;

  @ApiProperty({ description: '用户名', example: 'luobo' })
  username!: string;

  @ApiProperty({ type: String, description: '手机号；未绑定时为空', example: '13800000000', nullable: true })
  phone!: string | null;

  @ApiProperty({ description: '余额，单位：分', example: 17000 })
  balance_cents!: number;

  @ApiProperty({ description: '状态：`0` 正常 · `1` 禁用', enum: [0, 1], example: 0 })
  status!: number;

  @ApiProperty({ description: '注册时间（UTC ISO 8601）', example: '2026-09-30T03:00:00Z' })
  created_at!: string;

  @ApiProperty({ description: '累计充值（type=1 流水合计），单位：分', example: 50000 })
  recharge_total_cents!: number;

  @ApiProperty({ description: '累计消费（type=2 流水合计），单位：分', example: 33000 })
  consume_total_cents!: number;
}

/** 管理端用户列表响应 data */
export class AdminUserListView extends PageView {
  @ApiProperty({ description: '用户列表', type: [AdminUserView] })
  list!: AdminUserView[];
}

/** 管理端启停用户/管理员的结果 */
export class StatusChangeView extends OkView {
  @ApiProperty({ description: '变更后的状态：`0` 正常 · `1` 禁用', enum: [0, 1], example: 1 })
  status!: number;

  @ApiProperty({
    description: '本次被吊销的会话数。**仅管理员启停接口返回此字段**（禁用会强制下线；启用不恢复登录态）',
    example: 2,
    required: false,
  })
  revoked_sessions?: number;
}

/** 管理端管理员列表项 */
export class AdminAccountView {
  @ApiProperty({ description: '管理员用户 ID', example: '01a123f4-7110-795a-8102-e03731eefd14' })
  id!: string;

  @ApiProperty({ description: '用户名（登录名）', example: 'admin' })
  username!: string;

  @ApiProperty({ type: String, description: '手机号；未绑定时为空', example: null, nullable: true })
  phone!: string | null;

  @ApiProperty({ description: '状态：`0` 正常 · `1` 禁用', enum: [0, 1], example: 0 })
  status!: number;

  @ApiProperty({ description: '创建时间（UTC ISO 8601）', example: '2026-10-10T02:00:00Z' })
  created_at!: string;
}

/** 管理端管理员列表响应 data（管理员数量少，**不分页**） */
export class AdminAccountListView {
  @ApiProperty({ description: '管理员列表', type: [AdminAccountView] })
  list!: AdminAccountView[];

  @ApiProperty({ description: '管理员总数（含已禁用）', example: 2 })
  total!: number;
}

/** 创建管理员结果 */
export class AdminCreatedView {
  @ApiProperty({ description: '新建管理员的用户 ID', example: '01a123fc-c68a-762c-ac55-de911541ab67' })
  id!: string;

  @ApiProperty({ description: '用户名', example: 'ops_luobo' })
  username!: string;
}

/** 操作日志项 */
export class AuditLogView {
  @ApiProperty({ description: '日志 ID（**string**）', example: '30001' })
  id!: string;

  @ApiProperty({
    description: '操作人用户 ID（**取自已验证的 JWT，不可伪造**）',
    example: '01a123f4-7110-795a-8102-e03731eefd14',
  })
  operator_id!: string;

  @ApiProperty({ description: '操作人用户名；系统动作为 `system`', example: 'admin' })
  operator!: string;

  @ApiProperty({
    description: '操作类型（枚举见接口描述）',
    enum: [
      'recharge_confirm',
      'recharge_reject',
      'user_disable',
      'user_enable',
      'admin_create',
      'admin_disable',
      'admin_enable',
      'admin_password_reset',
      'password_change',
      'transaction_export',
      'reconciliation_run',
      'wallet_adjust',
      'system_bootstrap',
    ],
    example: 'recharge_confirm',
  })
  action!: string;

  @ApiProperty({
    type: String,
    description: '操作对象，形如 `apply:27` / `user:01a1...`',
    example: 'apply:27',
    nullable: true,
  })
  target!: string | null;

  @ApiProperty({
    description: '可读明细（随操作类型不同）。**自由结构**，前端按 key 通用渲染',
    type: 'object',
    additionalProperties: true,
    example: { reject: false, amount_cents: 30000 },
    nullable: true,
  })
  detail!: Record<string, unknown> | null;

  @ApiProperty({
    type: String,
    description: '操作来源 IP（IPv6 最长 45 字符）',
    example: '192.168.9.103',
    nullable: true,
  })
  ip!: string | null;

  @ApiProperty({ description: '发生时间（UTC ISO 8601）', example: '2026-10-09T10:05:00Z' })
  created_at!: string;
}

/** 操作日志列表响应 data */
export class AuditLogListView extends PageView {
  @ApiProperty({ description: '日志列表，按时间倒序', type: [AuditLogView] })
  list!: AuditLogView[];
}

// ───────────────────────── 对账（契约 §6）─────────────────────────

/** 日对账结果 */
export class ReconciliationView {
  @ApiProperty({ description: '对账业务日（YYYY-MM-DD）', example: '2026-10-09' })
  biz_date!: string;

  @ApiProperty({ description: '产品代码', example: 'storage' })
  product_code!: string;

  @ApiProperty({ description: '门户侧合计（分）', example: 130000 })
  portal_total_cents!: number;

  @ApiProperty({ description: '产品侧上报合计（分）', example: 130000 })
  product_total_cents!: number;

  @ApiProperty({ description: '差额（分）；**非 0 即有差异**', example: 0 })
  diff_cents!: number;

  @ApiProperty({ description: '差异笔数', example: 0 })
  diff_count!: number;

  @ApiProperty({
    description: '差异明细：仅产品侧有 / 仅门户侧有 / 金额不符',
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    example: [],
  })
  diffs!: Record<string, unknown>[];
}

/** 开通任务堆积情况（排障用） */
export class ProvisionJobsView {
  @ApiProperty({
    description: '各状态任务数：0 待处理 · 1 处理中 · 2 成功 · 3 失败。**key 为状态名，value 为数量**',
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { pending: 0, processing: 0, succeeded: 12, failed: 1 },
  })
  stats!: Record<string, number>;

  @ApiProperty({
    description: '失败任务样本（最多若干条），前端据此提示"有开通失败待处理"',
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    example: [],
  })
  failed_samples!: Record<string, unknown>[];
}

// ───────────────────────── 运维 ─────────────────────────

/** 探活响应 */
export class HealthView {
  @ApiProperty({
    description: '`ok` 数据库可达 · `degraded` 数据库不可达',
    example: 'ok',
    enum: ['ok', 'degraded'],
  })
  status!: string;

  @ApiProperty({ description: '运行环境', example: 'development' })
  env!: string;

  @ApiProperty({ description: '数据库连通性', example: 'up', enum: ['up', 'down'] })
  database!: string;

  @ApiProperty({ description: '响应时间（UTC ISO 8601）', example: '2026-10-10T03:00:00Z' })
  time!: string;
}

/** 服务元信息响应（不含任何密钥） */
export class MetaView {
  @ApiProperty({ description: '服务名', example: 'cloud-portal' })
  service!: string;

  @ApiProperty({ description: '当前依据的契约版本', example: '云平台统一门户 API 契约 v1.0 (2026-09-30)' })
  contract!: string;

  @ApiProperty({ description: 'JWT issuer', example: 'cloud-portal' })
  issuer!: string;

  @ApiProperty({ description: '当前生效的 JWT kid（轮换期会有多个）', example: 'portal-2026-10' })
  jwtKid!: string;

  @ApiProperty({ description: 'access token 有效期（秒）', example: 7200 })
  accessTtlSeconds!: number;

  @ApiProperty({ description: 'refresh token 有效期（秒）', example: 1209600 })
  refreshTtlSeconds!: number;

  @ApiProperty({ description: '已接入的产品代码', example: ['storage', 'phone', 'desktop'] })
  products!: string[];

  @ApiProperty({ description: '响应时间（UTC ISO 8601）', example: '2026-10-10T03:00:00Z' })
  time!: string;
}

/** 内网对账上报结果 */
export class ReportBillsView {
  @ApiProperty({ description: '本次接收的账单条数', example: 30 })
  received!: number;

  @ApiProperty({ description: '落库（插入或按 bill_no 幂等覆盖）的条数', example: 30 })
  upserted!: number;
}
