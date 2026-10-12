# cloud-portal · 服务端

云平台统一门户服务端（NestJS 10 + TypeORM + MySQL + Redis）。

> **上游依据**：《云平台统一门户 API 契约 v1.0》（2026-09-30 定稿），见工作区 `docs/original/云平台统一门户_API契约.md`
> **设计方案**：`docs/04-门户下一版方案_架构与ER.md`（架构 + 表结构 + 改造清单）
> **已拍板**：独立门户计费 · NestJS + Vue 3 + MySQL · 云存储先接入，桌面/云手机后续

---

## 进度

### 第 1 轮 · 地基 ✅
工程骨架 · 配置装载 · 9 张表实体 · 建表迁移 · 统一响应与异常过滤 · 探活 `/api/healthz`、`/api/meta` · 本地 compose。

### 第 2 轮 · 认证 + 钱包 + 充值核销 ✅（端到端 118 项全通过）

| 契约章节 | 接口 | 状态 |
|---|---|---|
| §1.1 | `POST /api/auth/register` 注册即建钱包 + 自动登录 | ✅ |
| §1.2 | `POST /api/auth/login`（支持用户名或手机号；refresh Cookie 14 天） | ✅ |
| §1.3 | `POST /api/auth/refresh` | ✅ |
| §1.4 | `POST /api/auth/logout`（吊销 refresh + 可选收紧 access） | ✅ |
| §1.5 | `GET /.well-known/jwks.json`（**无 /api 前缀**，标准 JWKS 不套壳） | ✅ |
| §3.1 | `GET /api/wallet/balance` | ✅ |
| §3.2 | `GET /api/wallet/transactions`（分页 + type/product_code 过滤） | ✅ |
| §3.3 | `POST /api/wallet/recharge/apply` | ✅ |
| 契约外补充 | `GET /api/wallet/recharges` **我的充值记录**（2026-10-10 按前端需求单实现；含 `balance_after` / `reject_reason`，可按 status 筛选） | ✅ |
| §4.1 | `POST /api/wallet/deduct`（内网 `X-Internal-Key`，幂等返回 3003） | ✅ |
| §4.2 | `POST /api/wallet/refund`（累计退款校验 3004 / 原单不存在 3005） | ✅ |
| §6 | `GET /api/admin/recharges`、`POST /api/admin/recharges/:id/confirm`、`GET /api/admin/transactions/export`（CSV） | ✅ |
| §0.2 / §0.6 | 统一响应壳 + 16 个错误码 | ✅ |
| 文档 | **OpenAPI / Swagger**：`/api/docs`（UI）+ `/api/docs-json`（导入 Apifox）；另有离线导出 `docs/openapi.json` | ✅ |

### 第 3 轮 · 商城与开通 ✅（端到端 83 项 + 退款路径 23 项全通过）

| 契约章节 | 接口 | 状态 |
|---|---|---|
| §2.1 | `GET /api/shop/products` 商品列表（只返回在售；stock 为 null = 现货；响应含 `catalog` 新鲜度——同步失败时 `stale=true`，避免静默返回旧价） | ✅ |
| §2.2 | `POST /api/shop/orders` 创建订单（**逐项校验 + 后端重算价格**） | ✅ |
| §2.3 | `GET /api/shop/orders/:id` 订单详情（按项返回状态） | ✅ |
| §2.4 | `POST /api/shop/orders/:id/pay` 支付（**逐项扣费同步 + 开通异步**） | ✅ |
| §5.1 | 商品目录同步（每 10 分钟全量 upsert，10 分钟级调价生效；不再上报的 sku 软下架） | ✅ |
| §5.2 | `POST /internal/provision` 调用（幂等键 `order_item_id`，30s 超时，失败重试 → 用尽自动退款） | ✅ |
| §6 | 日对账：产品账单上报 + 逐笔比对（仅产品侧 / 仅门户侧 / 金额不符）+ 手动补跑 | ✅ |
| 契约外补充 | `GET /api/shop/orders` 我的订单列表、`POST /api/internal/reconciliation/report` 账单上报 | ✅ |

### 第 4 轮 · 管理员账号 + 操作审计 + 管理端运营接口 ✅（管理端 78 项 + 第 2 轮 118 项全通过）

管理端原先用静态 `X-Admin-Key`，**无法区分操作人**——`?admin_id=` 那种"经办人由前端自报"的设计
让审计完全不可信。本轮改为**管理员账号**：

| 项 | 实现 |
|---|---|
| 管理员是什么 | `role='admin'` 的普通用户（**不建新表**），复用同一套登录 / argon2id / JWT / refresh |
| 首个管理员 | `.env` 的 `ADMIN_USERNAME/ADMIN_PASSWORD` 启动时**幂等创建并校准密码**（也是忘密码的找回入口） |
| 后续管理员 | `POST /api/admin/admins`（含列表 / 启用禁用 / 重置他人密码） |
| 鉴权 | JWT 的 `role` claim（签发时写入，每请求零额外查库）；失败仍返回 `1004`，前端处理逻辑不变 |
| 审计 | `a_audit_log` 表，`operator_id` 一律取自**已验证的 JWT**；覆盖核销/驳回/禁用/调账/改密/导出 |
| 禁用自己的保护 | 不能禁用自己、不能禁用最后一个可用管理员（否则只能改库救） |

新增管理端接口（对应前端《管理端-缺失接口需求清单》）：

```
GET  /api/admin/auth/verify              登录态校验（替代"随便调个业务接口看 1004"）
GET  /api/admin/users                    用户查询（含余额、累计充值/消费；只列普通用户）
POST /api/admin/users/{id}/status        禁用/恢复（disable+enable 合并）
GET  /api/admin/transactions             流水列表（含 username + user_balance_cents + 日期区间）
GET  /api/admin/audit-logs               操作日志
GET/POST /api/admin/admins*              管理员列表 / 创建 / 启用禁用 / 重置密码
POST /api/auth/password                  改自己的密码（任何登录用户）
```

`GET /api/admin/transactions/export` 补上 `start_date` / `end_date` / `limit`（导出是数据外泄面，必须可界定范围）。

### 尚未实现
前端（Vue 3，前端团队自建两个仓）· nginx 配置 · 统计概览 `stats/overview` · 人工调账 `wallets/{uid}/adjust`（第二批）。

---

> **支付为什么不是同步的**：契约 §2.4 写的是「逐项串行：扣费 → 调 provision(30s) → 失败退款」，若在 HTTP 请求里等，
> 并发几单就会把连接池和用户耐心一起耗光。本实现**严格保留契约的幂等键与状态语义**（`bill_no = order:{order_id}:item:{item_id}`、
> 余额不足即停止、已成功项保留、已完成订单再支付返回 4002），但把 provision 拆到后台 worker，
> 响应里已受理项状态为 `1 已支付`，前端**轮询订单详情**拿最终结果（`2 开通成功` / `4 已退款`）。

---

## 接口文档（给前端 / 产品侧联调）

三种拿法，按需选：

| 方式 | 地址 / 命令 | 说明 |
|---|---|---|
| Swagger UI | `http://127.0.0.1:3000/api/docs` | 可交互，能直接填 token 试接口（`SWAGGER_ENABLED=true` 时才有，**生产默认关闭**） |
| OpenAPI JSON（在线） | `http://127.0.0.1:3000/api/docs-json` | Apifox / Postman 可直接"导入 URL" |
| OpenAPI JSON（离线文件） | `docs/openapi.json`（已提交） | 不起后端也能导入；改完接口用 `node scripts/export-openapi.cjs` 重新生成 |

文档里已声明**两套**鉴权方案：`bearer`（用户端 + 管理端）、`internal-key`（§4 产品 → 门户）。

> 2026-10-10 起管理端从静态 `X-Admin-Key` 改为**管理员账号**（`role=admin` 的 JWT），
> `admin-key` 方案已从文档与代码中**删除**——原因见下面「管理端鉴权」一节。

> 注意：`/.well-known/jwks.json` 返回的是**标准 JWKS**，`/api/admin/transactions/export` 返回 **CSV**，这两者不套 `{code,message,data}` 壳，文档里已标注。

---

## 快速开始

```bash
# 1) 装依赖（argon2 是原生模块，需要编译；Windows 需 VS Build Tools）
npm install

# 2) 生成 JWT RS256 密钥（写入 keys/，已在 .gitignore）
npm run keys:generate

# 3) 配置环境变量
cp .env.example .env

# 4) 起本地 MySQL + Redis（本机已有则跳过，直接改 .env）
docker compose up -d

# 5) 建表（迁移纪律：一律 migration:run，不使用 synchronize）
npm run migration:run

# 6) 启动并自验
npm run start:dev
curl http://127.0.0.1:3000/api/healthz        # {"code":0,...,"data":{"status":"ok",...}}
node scripts/e2e-round2.cjs                    # 另开终端，118 项端到端
```

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run build` / `npm run clean` | 编译到 `dist/`（增量缓存放在 dist 内）；清理 |
| `npm run start:dev` / `start:prod` | 开发 watch / 生产 `node dist/main.js` |
| `npm run migration:run` / `migration:show` / `migration:revert` | 迁移三连 |
| `npm test` | 单元测试（**68 项**，不需要数据库） |
| `node scripts/e2e-round2.cjs` | 第 2 轮端到端（**118 项**：认证 / 钱包 / 核销 / 内网计费 / 密钥身份绑定 / bill_no 全局唯一 / 公开接口限流 / OpenAPI 文档） |
| `node scripts/e2e-admin.cjs` | **管理端端到端（78 项）**：管理员登录与权限边界 / 用户禁用恢复 / 流水与日志 / 管理员 CRUD / 改密码 / 导出留痕 |
| `powershell -File scripts/run-e2e-round3.ps1` | **第 3 轮端到端（83 项）**：自动清端口、起产品桩、重置商品缓存、跑完自动清理 |
| `node scripts/check-openapi-responses.cjs` | **检查所有接口是否都声明了响应结构**（漏写会失败，防"前端靠猜字段名"） |
| `node scripts/check-openapi-nullable-types.cjs` | **检查 nullable 字段类型是否标错**（TS 反射会把 `string \| null` 退化成 `object`） |
| `powershell -File scripts/run-e2e-refund.ps1` | **退款路径验证（23 项）**：产品桩以 `PROVISION_MODE=fail` 启动，验证失败自动退款闭环 |
| `node scripts/stub-product-server.cjs` | 云存储侧接口桩（`GET /internal/products` + `POST /internal/provision`，支持故障注入） |
| `node scripts/export-openapi.cjs` | 导出离线 `docs/openapi.json`（需先 `npm run build` 且能连库） |
| `node scripts/probe-mysql.cjs` | 探测目标 MySQL 版本 / 排序规则 / 已有表 |
| `node scripts/reset-products.cjs` | 清空商品缓存（只动 `p_product*`，不碰用户与钱包） |
| `npm run lint` | ESLint |

---

## 关键约定（改动前务必读）

1. **金额一律整数「分」**，字段名统一 `*_cents`；时间统一存 UTC（`DATETIME(3)`），展示层再转本地。
2. **响应恒为** `{ code, message, data }`，HTTP 状态码一律 **200**（404/405 除外）。业务码见 `src/common/error-code.ts`，**禁止散落魔法数字**。
   - ⚠️ **Nest 对 POST 默认返回 201**，与契约冲突。所有 POST handler 必须标 `@HttpCode(200)` + `@ApiOkResponse()`（后者让 Swagger 也如实标注 200）。端到端里有断言盯着这条。
3. **两个接口例外、不套壳**，必须标 `@RawResponse()`：§1.5 JWKS（产品侧按标准 JWKS 解析）、§6 CSV 导出。
4. **幂等**：`bill_no`（`w_transaction` 唯一索引）、`order_item_id`（订单项主键 = 产品 provision 幂等键）。先落库生成单号，再发请求。
5. **钱包扣费只走条件原子更新**：
   ```sql
   UPDATE w_wallet SET balance_cents = balance_cents - ?
    WHERE user_id = ? AND status = 0 AND balance_cents >= ?
   ```
   影响行数 = 0 即余额不足/冻结；因此钱包表**不设 version 乐观锁列**。
6. **充值核销用条件更新** `WHERE id=? AND status=0` 抢占状态，赢家才动钱（防两个管理员同时点通过导致重复增额）。
7. **用户 ID 全系统统一 `CHAR(36)`**（UUIDv7 字符串），不做 `BINARY(16)` 转换。
7.1 **支付逐项扣费**：`bill_no = order:{order_id}:item:{item_id}`（契约 §2.4 原文），并在流水上带 `product_code` 便于对账归集；某一项余额不足即**停止处理后续项**，已成功项保留。
7.2 **开通与扣费解耦**：扣费在 HTTP 请求内完成（用户要知道钱够不够），provision 交给 `ProvisionWorker` 后台推进；契约的幂等键与状态语义全部保留。
8. **门户不直连任何产品数据库**；跨系统只走契约里的 HTTP 接口（内网 + `X-Internal-Key`）。
9. **内网接口不对公网暴露**（契约附录自检项）：`/api/wallet/deduct`、`/api/wallet/refund`、`/api/internal/reconciliation/report` 只靠密钥鉴权，必须由防火墙/nginx 限制来源。
10. 密钥、密码、AK **不进仓库**：`.env` 与 `keys/` 已被 `.gitignore` 忽略。

## 管理端鉴权：管理员账号（2026-10-10 起，废弃 `X-Admin-Key`）

**为什么换**：静态密钥**无法区分操作人**。原先 `POST /admin/recharges/:id/confirm?admin_id=` 的
"经办人"由前端自报、可任意伪造，而核销充值、禁用用户、重置密码都是资金/权限操作，
出问题必须能追到人。现在管理员就是 `role='admin'` 的普通用户，审计日志的 `operator_id`
取自**已验证的 JWT**。

| 项 | 规则 |
|---|---|
| 首个管理员 | 环境变量 bootstrap（幂等，每次启动校准密码 → 也是忘密码的找回入口）。**不能用接口创建**，否则"部署完到建好管理员"之间有时间窗 |
| 后续管理员 | `POST /api/admin/admins`；每人数一个账号，**不要共用**（共用则审计退回不可追溯） |
| 鉴权链 | `JwtAuthGuard` 把 JWT 的 `role` 填进 `request.user` → `AdminGuard` 判断 `role === 'admin'` |
| ⚠️ 控制器禁止标 `@Public()` | 标了就绕过 JWT，`AdminGuard` 拿不到 `request.user`，连合法管理员也会被拒（早期"路径二"就是这么变成死代码的） |
| 注册接口 | `role` **写死 `user`**，绝不从请求体读取，否则任何人都能注册出管理员 |
| 失败码 | 仍为 **`1004`**（授权失败），前端错误处理无需改动 |
| 自我保护的守卫 | 不能禁用自己；不能禁用**最后一个可用管理员**（否则只能改库救） |
| 密码变更 | 一律**吊销该用户全部 refresh 会话**（所有设备强制重登）；改自己密码必须提供旧密码 |

**配置（`.env`）**：

```bash
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<强密码，8-64 位且含字母和数字>   # 生产必须换掉，且不与测试环境共用
ADMIN_PHONE=                                     # 可选
```

## 内网鉴权：密钥与产品身份**绑定**（重要不变量）

> **密钥认证出的产品身份 = 内网接口里唯一可信的产品身份。请求体里的 `product_code` 只是"自报"，必须与它一致。**

这条不是可选优化，是安全边界。早先的实现用 `products.some(...)` 只判断"密钥属于**某一个**已配置产品"，
于是 **任意一个产品都能在 body 里写别人的 `product_code`**，把账记到别人头上、或退掉别人的账单。
现在改成 `find(...)` 并把命中结果挂到 `request.internalProduct`：

| 位置 | 规则 |
|---|---|
| `InternalKeyGuard` | 命中**唯一**产品才放行；命中多个（多家配了同一把密钥）→ **fail-closed 拒绝**并打 ERROR 日志 |
| `ProductScopeGuard` | body 里的 `product_code` 与密钥归属不一致 → **1004**；不传 → 按密钥推定（兼容存量接入） |
| `POST /wallet/deduct` | `productCode` 取 `@CurrentInternalProduct().code`，**不再读 dto** |
| `POST /wallet/refund` | 不要求 body 带 `product_code`；改为校验**原账单归属**（`w_transaction.product_code`），跨产品退款 → **1004** |
| `POST /internal/reconciliation/report` | 强制覆写 `product_code` 为认证结果，防止污染别的产品的对账口径 |

**两条给接入方的硬约束**：
1. **每家产品一把独立密钥**。若三家配成同一个值，门户会拒绝全部内网请求（这是有意的：配错要立刻炸，而不是静默取第一个）。
2. **账单号必须带产品前缀**。`w_transaction.bill_no` 是**全局唯一**（`uk_txn_bill_no`），不是按产品唯一 ——
   两个产品发出同样的 `bill_no` 时，后到的会被当成幂等重复（`3003`）而**扣不到钱**。
   例：云存储的 `storage-20261009-000002` 安全；裸的 `20261009-000002` 早晚撞。

### 入站鉴权与出站同步**解耦**（别把它们当成一个开关）

产品列表里可能有两种条目：

| 条目 | `enabled` | 参与商品同步 | 参与开通 | 参与**入站鉴权** |
|---|---|---|---|---|
| 配了地址（+ 密钥） | `true` | ✅ | ✅ | ✅ |
| **只配了密钥**（地址为空） | `false` | ❌ | ❌ | ✅ |

**为什么要有第二种**：入站鉴权（产品调门户扣费/退款/报账单）和出站同步（门户拉商品/发起开通）
是**两件独立的事**。早先只按 `enabled` 过滤产品，导致「清空某产品地址以暂停同步」会
**连带把它的扣费请求也拒掉**（密钥不再被加载 → 对方收到 `1002`），排查时极难联想到是同步开关引起的。

所以现在：`.filter((item) => item.enabled || item.internalKey.length > 0)`。
只配密钥的产品在同步侧被 `ProductSyncService.forSync()` 过滤掉，开通侧被 `ProductClient.findByCode()` 拦住，
不会误发空地址请求。

**运维含义**：想临时停掉某产品的商品同步，把它的 `*_BASE_URL` 注释掉即可，**它的扣费/退款不受影响**。

### 本地自验与真实云存储是分开的

`.env` 里的 `PRODUCT_STORAGE_*` 指向**真实云存储**（联调时把地址填上）。
本地跑三套 e2e 时，`run-e2e-*.ps1` 会用**进程环境覆盖** `PRODUCT_STORAGE_BASE_URL` 与
`PRODUCT_STORAGE_INTERNAL_KEY` 指向测试桩（见脚本第 4 步）—— 因为
`process.loadEnvFile` 不覆盖已存在的环境变量，**跑自验永远不会打到真实云存储**。

桩自己的密钥在 `STUB_PRODUCT_INTERNAL_KEY`（默认 `stub-storage-key`），与真实密钥无关：

| 变量 | 用途 | 谁用 |
|---|---|---|
| `PRODUCT_STORAGE_INTERNAL_KEY` | 真实云存储的密钥 | 门户（联调/生产） |
| `STUB_PRODUCT_INTERNAL_KEY` | 测试桩的密钥 | `stub-product-server.cjs` + e2e 脚本 |

⚠️ **改完 `.ps1` 记得跑 `node scripts/ensure-ps1-bom.cjs`**：PowerShell 5.1 读无 BOM 的 UTF-8
会按 ANSI 解码，中文注释里的引号会打乱语法，报出一堆与真实原因无关的 ParserError。
很多编辑器（含 AI 编辑工具）保存时会丢掉 BOM。

## 开通 worker（第 3 轮新增）

`ProvisionWorker` 每 3 秒扫一次 `o_provision_job`，逐条调产品 `POST /internal/provision`：

| 机制 | 说明 |
|---|---|
| 认领原子性 | 条件更新 `pending → processing`，多实例不会重复处理同一条 |
| 卡死恢复 | `processing` 超过 `PROVISION_STALE_MS`（默认 5 分钟）自动重新入队（进程被杀的兜底） |
| 重试策略 | 业务失败（4003/4004）**不重试**；系统失败（超时/5xx）重试到 `PROVISION_MAX_ATTEMPTS`（默认 3） |
| 失败退款 | 用尽次数 → 自动调 `refund`，退款单号 `refund:{order_item_id}:{attempts}` 保证不重复退 |
| 退款再失败 | 订单项置 `3 失败待退款` 交给对账，**绝不留"钱扣了没人管"** |
| 排障 | `GET /api/admin/reconciliation/provision-jobs` 看各状态堆积量 |

## 环境要求与坑

| 项 | 说明 |
|---|---|
| Node | ≥ 20（用到 `process.loadEnvFile`，免 dotenv 依赖）。本仓库在 Node 24 上验证 |
| MySQL | **5.7 与 8.0 均可**（实测 5.7.26 通过）。排序规则固定 `utf8mb4_general_ci` |
| Redis | 5.0+（用到 `INCR`/`EXPIRE`/`TTL`/`SET EX`/`SCAN`/`SADD`/`SMEMBERS`/`SREM`）。Redis 不可用时登录/注册会失败，而限流与吊销查询**降级放行**（可用性优先） |
| argon2 | 原生模块，安装时需编译。受限环境可用 `npm install --ignore-scripts` 装依赖做类型检查，但**运行时加载会失败** |

> ⚠️ **字符集坑（已踩并修）**：迁移里别写 `utf8mb4_0900_ai_ci`（MySQL 8.0 专属）。在 5.7 上它**不报错**，而是静默降级成 `utf8mb4_general_ci`，导致不同环境实际排序规则不一致。现统一用 `utf8mb4_general_ci`。

> ⚠️ **`process.loadEnvFile` 的空值语义**：它把「`KEY=`」视为**未设置**，不会用空串覆盖已有环境变量。所以想把某产品设为"未接入"，要**删掉那一行或注释掉**，而不是留空值（留空值在部分环境下会被误认为设过）。

> ⚠️ **自验脚本必须清端口**：反复手工起服务最容易踩 `EADDRINUSE` —— 表现是「测试打到了上一次的旧进程」，错误信息却完全不指向端口。`run-e2e-*.ps1` 已经做了清理，手工起服务时记得先杀干净。

> ⚠️ **POST 默认 201（已修）**：契约 §0.2 要求所有接口 HTTP 200，而 Nest 对 POST 默认返回 201。
> 早期版本就是这么错的——被 Swagger 文档"如实暴露"出来才发现。现在每个 POST 都标了 `@HttpCode(200)`，
> 并且端到端里加了「成功的 POST 也必须是 200」的断言，回归时会被拦住。

## 目录结构

```
src/
├─ main.ts                     # 引导：/api 前缀（排除 .well-known）、cookie、响应拦截、异常过滤、校验管道
├─ app.module.ts               # 根模块（配置 + Redis + JWT + TypeORM + 全局鉴权）
├─ app.controller.ts           # /api/healthz、/api/meta（@Public）
├─ common/
│  ├─ error-code.ts            # 契约 §0.6 错误码 + BizException
│  ├─ response.interceptor.ts  # 契约 §0.2 统一响应（@RawResponse 例外）
│  ├─ raw-response.decorator.ts
│  ├─ all-exceptions.filter.ts # 业务失败也返回 HTTP 200
│  ├─ jwt-auth.guard.ts        # 全局 JWT 鉴权（1002/1003 + 登出吊销检查）
│  ├─ internal-key.guard.ts    # 契约 §4 内网 X-Internal-Key（**密钥 → 产品身份绑定**）
│  ├─ internal-product.types.ts / .decorator.ts  # 身份载体与 @CurrentInternalProduct()
│  ├─ product-scope.guard.ts   # body 自报的 product_code 必须与密钥归属一致，否则 1004
│  ├─ admin.guard.ts           # 契约 §6 管理端 X-Admin-Key
│  ├─ rate-limiter.service.ts  # Redis 固定窗口限流（故障降级放行）
│  ├─ redis.{constants,provider,module,store}.ts
│  ├─ crypto.util.ts           # uuidv7 / randomToken / sha256 / safeEqual
│  └─ request.util.ts          # Bearer 解析 / 客户端 IP
├─ config/
│  ├─ configuration.ts         # 环境变量 → 类型化配置（含"未接入产品"的 enabled 判定）
│  ├─ portal-config.service.ts
│  ├─ swagger.setup.ts         # OpenAPI 文档（/api/docs）+ @RawResponse 说明
│  └─ token.module.ts          # JWT 签发（RS256；缺私钥启动即失败）
├─ database/
│  ├─ entities.ts              # 11 张表实体清单（连接与迁移共用）
│  ├─ data-source.ts           # TypeORM CLI / 迁移专用
│  └─ migrations/
│     ├─ 1759600000000-InitPortalSchema.ts        # 9 张表
│     ├─ 1759700000000-ShopAndProvision.ts        # 开通任务队列 + 账单上报 + o_order.paying_at
│     └─ 1759700001000-ReconciliationDiffColumns.ts # 对账差异分类列
└─ modules/
   ├─ auth/                    # §1 认证 + JWKS（password / token / jwks service）
   ├─ wallet/                  # §3 钱包 + §6 管理端（wallet-ledger 是资金唯一入口）
   ├─ internal/                # §4 内网计费（deduct / refund）
   ├─ user/                    # u_user 实体
   ├─ product/                 # §5.1 商品目录同步 + ProductClient（门户外呼产品的唯一出口）
   ├─ order/                   # §2 商城与订单 + ProvisionWorker（§5.2 开通与自动退款）
   └─ reconciliation/          # §6 账单上报 + 日对账
scripts/                       # 密钥生成 / MySQL 探测 / OpenAPI 导出 / 产品桩 / 端到端自验
docker-compose.yml             # 本地 MySQL 8 + Redis 7
```
