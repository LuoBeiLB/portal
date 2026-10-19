import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * 商城接口的**响应**模型（2026-10-10 新增）。
 *
 * 为什么单独一个文件：C 组前端反馈 Swagger 里所有接口**只有入参、没有响应结构**
 * （`components.schemas` 里 15 个模型全是 `XxxDto`），前端只能"实际调一次、把返回打印出来猜字段名"。
 *
 * 这里刻意**不复用入参 DTO**：入参用 snake_case、响应也用 snake_case 但字段集完全不同
 * （例如响应有 `order_id` 而入参没有），混用会让文档更难读。
 *
 * ⚠️ 注意：这些类只用于**生成文档**，实际返回值由 service 里的 `XxxView` 接口约束。
 * 两边字段必须保持一致——`e2e-round2.cjs` 里有断言盯着响应字段完备性。
 */

/** 契约 §2.1 商品列表项 */
export class ProductView {
  @ApiProperty({ description: '产品代码', enum: ['storage', 'phone', 'desktop'], example: 'storage' })
  product_code!: string;

  @ApiProperty({ description: '产品内 SKU ID', example: 'storage-500g' })
  sku_id!: string;

  @ApiProperty({ description: '门户展示名', example: '云存储·500G' })
  name!: string;

  @ApiProperty({
    description: '**产品自定义结构**，门户原样透传。前端要按 key 通用渲染，不要假设一定有某个字段',
    type: 'object',
    additionalProperties: true,
    example: { quota_gb: 500, transfer: 'unlimited' },
    nullable: true,
  })
  spec!: Record<string, unknown> | null;

  @ApiProperty({ description: '单价，单位：**分**', example: 50000 })
  price_cents!: number;

  @ApiProperty({ description: '计费模式：1 包周期（下单即扣） 2 按量（后付费由产品出账）', enum: [1, 2], example: 1 })
  billing_mode!: number;

  @ApiProperty({
    type: Number,
    description:
      '周期长度，单位**小时**（2026-10-14 起）。按量计费（`billing_mode=2`）时为 null。\n\n' +
      '换算：`24` = 1 天、`720` = 30 天、`3` = 3 小时。\n\n' +
      '**前端展示规则**：`% 24 === 0` 显示「N 天」，否则显示「N 小时」。**不要再按天换算**。',
    example: 720,
    nullable: true,
  })
  period_hours!: number | null;

  @ApiProperty({
    type: Number,
    description:
      '**已废弃（兼容字段）**：周期天数 = `ceil(period_hours / 24)`。仅为尚未改造的调用方保留，新代码请用 `period_hours`。',
    example: 30,
    nullable: true,
    deprecated: true,
  })
  period_days!: number | null;

  @ApiProperty({
    type: Number,
    description: '库存；**null = 不限或产品未上报 → 前端显示「现货」而不是「0 件」**',
    example: null,
    nullable: true,
  })
  stock!: number | null;

  @ApiProperty({ description: '最近一次从产品同步到门户的时间（UTC ISO 8601）', example: '2026-10-10T03:00:00Z' })
  synced_at!: string;
}

/** 商品目录新鲜度（2026-10-12 新增）：让前端知道"这些价格是不是最新的" */
export class CatalogFreshnessView {
  @ApiProperty({
    description:
      '**`true` = 当前目录不可信**：最近一次同步失败，或目录数据超过 3 个同步周期没更新。\n\n' +
      '为什么需要：同步失败时门户**保留上一次成功的目录**（宁愿卖旧价也不让商城空掉），\n' +
      '所以会出现"日志一直在报同步失败，但商品列表照常返回"的情况 —— 前端据此提示\n' +
      '「价格可能不是最新，下单前请确认」，管理端也可据此报警。',
    example: true,
  })
  stale!: boolean;

  @ApiProperty({
    type: String,
    description: '最近一次同步**尝试**的时间（失败也算尝试），UTC ISO 8601；从未同步过为 `null`',
    example: '2026-10-12T01:32:13Z',
    nullable: true,
  })
  last_sync_at!: string | null;

  @ApiProperty({ type: Boolean, description: '最近一次同步是否成功；无记录为 `null`', example: false, nullable: true })
  last_sync_ok!: boolean | null;

  @ApiProperty({
    type: String,
    description: '最近一次失败原因（如 `timeout of 10000ms exceeded`）；成功或无记录为 `null`',
    example: 'timeout of 10000ms exceeded',
    nullable: true,
  })
  last_error!: string | null;

  @ApiProperty({
    type: String,
    description:
      '目录里最新一条商品的同步时间 = **当前展示价格的新鲜度**；无商品为 `null`。\n' +
      '与 `last_sync_at` 的区别：后者是"最近一次尝试"，这个是"数据实际停留在什么时候"。',
    example: '2026-10-10T09:24:01Z',
    nullable: true,
  })
  data_synced_at!: string | null;
}

/** 商品列表响应 data */
export class ProductListView {
  @ApiProperty({ description: '在售商品列表（不分页）', type: [ProductView] })
  list!: ProductView[];

  @ApiProperty({ description: '目录新鲜度（判断展示价格是否可信）', type: CatalogFreshnessView })
  catalog!: CatalogFreshnessView;
}

/** 契约 §2.3 订单项 */
export class OrderItemView {
  @ApiProperty({ description: '订单项 ID（**string**；同时是产品开通的幂等键）', example: '90' })
  item_id!: string;

  @ApiProperty({ description: '产品代码', example: 'storage' })
  product_code!: string;

  @ApiProperty({ description: '产品内 SKU ID', example: 'storage-500g' })
  sku_id!: string;

  @ApiProperty({ type: String, description: '商品名（下单时快照）', example: '云存储·500G', nullable: true })
  name!: string | null;

  @ApiProperty({ description: '数量', example: 1 })
  quantity!: number;

  @ApiProperty({ description: '下单时单价快照，单位：分', example: 50000 })
  price_cents!: number;

  @ApiProperty({
    description: '订单项状态：`0` 待支付 · `1` 已支付（**开通中**）· `2` 开通成功 · `3` 失败待退款 · `4` 已退款',
    enum: [0, 1, 2, 3, 4],
    example: 2,
  })
  status!: number;

  @ApiProperty({ type: String, description: '产品返回的实例 ID；仅开通成功时非空', example: 'st-0001', nullable: true })
  instance_id!: string | null;

  @ApiProperty({
    type: String,
    description: '到期时间（UTC ISO 8601）；仅开通成功时非空',
    example: '2026-11-09T03:00:00Z',
    nullable: true,
  })
  expire_at!: string | null;

  @ApiProperty({
    type: String,
    description:
      '开通失败原因（机器码，仅失败/退款时有值）。\n\n' +
      '**取值清单（D 组 D-F1，2026-10-10 从实现里核对）**：\n' +
      '- `PROVISION_FAILED` —— 调用产品开通接口失败且重试耗尽（**最常见**）\n' +
      '- `PROVISION_REJECTED` —— 产品明确拒绝但未带业务码\n' +
      '- `4003` —— 产品侧报「商品不存在或已下架」（数字码由**产品**回传）\n' +
      '- `4004` —— 产品侧报「库存不足」（同上）\n' +
      '  ⚠️ 这两个数字码只在**产品返回非 0 `code`** 时出现。若产品用非标准 code（如 500），\n' +
      '  这里会落成产品自己的数字（如 `"500"`）——**前端必须有兜底文案**\n' +
      '- `NETWORK` —— 网络失败/超时（重试后通常落成 `PROVISION_FAILED`）\n' +
      '- `BAD_RESPONSE` —— 产品返回成功但缺 `instance_id`\n\n' +
      '**兜底建议**：未在清单内一律显示「开通失败，已自动退款」。\n' +
      '门户**不做中文翻译**（这些是产品侧机器码，可能新增），故不提供 `fail_reason_text`；\n' +
      '如需中文由前端维护映射表。',
    example: 'PROVISION_FAILED',
    nullable: true,
  })
  fail_reason!: string | null;

  @ApiProperty({
    type: String,
    description:
      '**退款流水号**，形如 `refund:{item_id}:{attempt}`；非退款项为 `null`（2026-10-10 新增，D 组 D-F3）。\n\n' +
      '用途：前端可从订单详情**直接定位这笔退款**（去流水页搜这个 `bill_no` 即可），\n' +
      '不必按金额和时间人工翻找。与扣费单 `order:{order_id}:item:{item_id}` 一一对应。',
    example: 'refund:90:1',
    nullable: true,
  })
  refund_bill_no!: string | null;

  @ApiProperty({
    type: String,
    description: '**退款到账时间**（UTC ISO 8601，即退款流水的记账时间）；非退款项为 `null`',
    example: '2026-10-10T03:05:00Z',
    nullable: true,
  })
  refunded_at!: string | null;
}

/** 契约 §2.3 订单（详情 = 列表项结构，**前端可复用同一张卡片组件**） */
export class OrderView {
  @ApiProperty({ description: '订单 ID（**string**）', example: '78' })
  order_id!: string;

  @ApiProperty({ description: '订单号，形如 `O20261010-483920`', example: 'O20261010-483920' })
  order_no!: string;

  @ApiProperty({ description: '订单总额，单位：分（后端按缓存价重算，不信任前端传价）', example: 50000 })
  total_cents!: number;

  @ApiProperty({
    description: '订单状态：`0` 待支付 · `1` 部分成功 · `2` 全部成功 · `3` 全部失败',
    enum: [0, 1, 2, 3],
    example: 1,
  })
  status!: number;

  @ApiProperty({ description: '创建时间（UTC ISO 8601）', example: '2026-10-10T03:00:00Z' })
  created_at!: string;

  @ApiProperty({ type: String, description: '支付时间；未支付时为空', example: '2026-10-10T03:01:00Z', nullable: true })
  paid_at!: string | null;

  @ApiProperty({ description: '订单项（按项返回状态，**前端要按项渲染**）', type: [OrderItemView] })
  items!: OrderItemView[];
}

/** 我的订单列表响应 data（契约外补充接口） */
export class OrderListView {
  @ApiProperty({ description: '订单列表（含 items，结构与订单详情一致）', type: [OrderView] })
  list!: OrderView[];

  @ApiProperty({ description: '总条数（`status` 筛选后为筛选结果数）', example: 3 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  size!: number;
}

/** 契约 §2.2 创建订单响应 = 订单详情 */
export class CreateOrderResultView extends OrderView {}

/** 契约 §2.3 订单详情响应 = 订单结构（单独命名便于文档里区分语义） */
export class OrderDetailView extends OrderView {}

/** 契约 §2.4 支付响应：订单 + 受理进度 */
export class PayResultView extends OrderView {
  @ApiProperty({ description: '本次**受理**的项数（已扣费、正在开通），不是开通成功数', example: 1 })
  accepted_items!: number;

  @ApiProperty({
    description: '仍在开通中的项数。**> 0 时前端应轮询订单详情**（建议 1~2 秒一次），直到没有项处于状态 `1`',
    example: 1,
  })
  processing_items!: number;
}

/** 分页响应壳（多处复用） */
export class PageMetaView {
  @ApiProperty({ description: '总条数', example: 57 })
  total!: number;

  @ApiProperty({ description: '当前页码', example: 1 })
  page!: number;

  @ApiProperty({ description: '每页条数', example: 20 })
  size!: number;
}

/**
 * 契约 §3.2 资金流水项。
 * 用户端与管理端共用字段集；管理端额外带 `username` / `user_balance_cents`。
 */
export class TransactionView {
  @ApiProperty({ description: '流水 ID（**string**）', example: '9001' })
  id!: string;

  @ApiProperty({ description: '类型：`1` 充值 · `2` 扣费 · `3` 退款 · `4` 调账', enum: [1, 2, 3, 4], example: 2 })
  type!: number;

  @ApiProperty({ description: '金额，单位：分（正数，方向由 type 决定）', example: 50000 })
  amount_cents!: number;

  @ApiProperty({ description: '本次流水完成后的余额快照，单位：分', example: 17000 })
  balance_after!: number;

  @ApiProperty({
    type: String,
    description: '产品代码；门户内部流水（充值/调账）为空',
    example: 'storage',
    nullable: true,
  })
  product_code!: string | null;

  @ApiProperty({ description: '幂等键：产品账单号 / 充值单号 / 退款单号', example: 'storage-20261005-000123' })
  bill_no!: string;

  @ApiProperty({ type: String, description: '退款流水指向的原扣费单号；非退款为空', example: null, nullable: true })
  refund_of_bill_no!: string | null;

  @ApiProperty({
    description: '账单明细（产品传入时原样入）。**自由结构**，前端按 key 通用渲染',
    type: 'object',
    additionalProperties: true,
    example: { plan: '续费·标准版' },
    nullable: true,
  })
  detail!: Record<string, unknown> | null;

  @ApiProperty({ description: '发生时间（UTC ISO 8601）', example: '2026-10-05T02:00:00Z' })
  created_at!: string;
}

/** 流水列表响应 data */
export class TransactionListView extends PageMetaView {
  @ApiProperty({ description: '流水列表，按时间倒序', type: [TransactionView] })
  list!: TransactionView[];
}

/** 管理端流水项：比用户端多两个核对字段 */
export class AdminTransactionView extends TransactionView {
  @ApiProperty({ description: '所属用户 ID', example: '01a11e65-3a34-7578-95a7-ebfdd8cd731c' })
  user_id!: string;

  @ApiProperty({ type: String, description: '所属用户名（管理端核对用）', example: 'luobo', nullable: true })
  username!: string | null;

  @ApiProperty({ type: Number, description: '该用户**当前**余额，单位：分', example: 17000, nullable: true })
  user_balance_cents!: number | null;
}

/** 管理端流水列表响应 data */
export class AdminTransactionListView extends PageMetaView {
  @ApiProperty({ description: '流水列表，按时间倒序', type: [AdminTransactionView] })
  list!: AdminTransactionView[];
}

/** 用户端「我的充值记录」项（2026-10-10 新增） */
export class MyRechargeView {
  @ApiProperty({ description: '充值申请单号（**string**）', example: '60' })
  apply_id!: string;

  @ApiProperty({ description: '申请金额，单位：分', example: 10000 })
  amount_cents!: number;

  @ApiProperty({ description: '状态：`0` 待核销 · `1` 已到账 · `2` 驳回', enum: [0, 1, 2], example: 1 })
  status!: number;

  @ApiProperty({
    type: Number,
    description: '**到账后余额**；仅 `status=1` 时非空（其余状态为 null，不是 0）',
    example: 10000,
    nullable: true,
  })
  balance_after!: number | null;

  @ApiProperty({
    type: String,
    description: '驳回原因；仅 `status=2` 时非空',
    example: '转账凭证不清晰',
    nullable: true,
  })
  reject_reason!: string | null;

  @ApiProperty({ type: String, description: '用户提交时填写的转账备注', example: '微信转账，尾号1234', nullable: true })
  remark!: string | null;

  @ApiProperty({ description: '申请时间（UTC ISO 8601）', example: '2026-10-10T03:27:00Z' })
  created_at!: string;
}

/** 我的充值记录响应 data */
export class MyRechargeListView extends PageMetaView {
  @ApiProperty({ description: '充值记录，按申请时间倒序', type: [MyRechargeView] })
  list!: MyRechargeView[];
}

/** 管理端充值核销队列项：用户端字段 + 用户与经办人的核对字段 */
export class AdminRechargeView extends MyRechargeView {
  @ApiProperty({ description: '申请用户 ID', example: '01a11e65-3a34-7578-95a7-ebfdd8cd731c' })
  user_id!: string;

  @ApiProperty({ type: String, description: '申请用户名（管理端核对用）', example: 'luobo', nullable: true })
  username!: string | null;

  @ApiProperty({ type: String, description: '申请用户手机号', example: '13800000000', nullable: true })
  phone!: string | null;

  @ApiProperty({
    type: String,
    description: '经办人（管理员）用户 ID；未核销时为空',
    example: '01a123f4-7110-795a-8102-e03731eefd14',
    nullable: true,
  })
  reviewed_by!: string | null;

  @ApiProperty({
    type: String,
    description: '**经办人用户名**（前端展示用这个，不要展示 UUID）。2026-10-10 新增',
    example: 'admin',
    nullable: true,
  })
  reviewed_by_username!: string | null;
}

/** 管理端核销队列响应 data */
export class AdminRechargeListView extends PageMetaView {
  @ApiProperty({ description: '充值申请列表，按申请时间倒序', type: [AdminRechargeView] })
  list!: AdminRechargeView[];
}

/** 管理端核销结果 */
export class RechargeConfirmResultView {
  @ApiProperty({ description: '被核销的申请单号（**string**）', example: '60' })
  apply_id!: string;

  @ApiProperty({ description: '核销后状态：`1` 已到账 · `2` 已驳回', enum: [1, 2], example: 1 })
  status!: number;

  @ApiProperty({ type: Number, description: '到账后余额，单位：分；**驳回时为 null**', example: 10000, nullable: true })
  balance_cents!: number | null;

  @ApiProperty({ type: String, description: '到账产生的流水 ID；驳回时为空', example: '9001', nullable: true })
  transaction_id?: string;
}
