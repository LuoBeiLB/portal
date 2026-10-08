# cloud-portal · 服务端

云平台统一门户服务端（NestJS 10 + TypeORM + MySQL + Redis）。

> **上游依据**：《云平台统一门户 API 契约 v1.0》（2026-09-30 定稿），见工作区 `docs/original/云平台统一门户_API契约.md`
> **设计方案**：`docs/04-门户下一版方案_架构与ER.md`（架构 + 表结构 + 改造清单）
> **已拍板**：独立门户计费 · NestJS + Vue 3 + MySQL · 云存储先接入，桌面/云手机后续

---

## 进度

### 第 1 轮 · 地基 ✅
工程骨架 · 配置装载 · 9 张表实体 · 建表迁移 · 统一响应与异常过滤 · 探活 `/api/healthz`、`/api/meta` · 本地 compose。

### 第 2 轮 · 认证 + 钱包 + 充值核销 ✅（端到端 64 项全通过）

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
| §4.1 | `POST /api/wallet/deduct`（内网 `X-Internal-Key`，幂等返回 3003） | ✅ |
| §4.2 | `POST /api/wallet/refund`（累计退款校验 3004 / 原单不存在 3005） | ✅ |
| §6 | `GET /api/admin/recharges`、`POST /api/admin/recharges/:id/confirm`、`GET /api/admin/transactions/export`（CSV） | ✅ |
| §0.2 / §0.6 | 统一响应壳 + 16 个错误码 | ✅ |

### 第 3 轮 · 商城与开通（未开始）
商品目录同步（§5.1）· 创建订单 / 订单详情 / 支付（§2）· 调产品 `POST /internal/provision` + 失败自动退款 · 支付异步化 · 日对账（§6）。

### 尚未实现
前端（Vue 3，另外一个仓）· nginx 配置 · `u_user.role` 与真正的管理端角色校验（当前管理端走 `X-Admin-Key` 静态密钥，契约 §6 允许）。

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
node scripts/e2e-round2.cjs                    # 另开终端，64 项端到端
```

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run build` / `npm run clean` | 编译到 `dist/`（增量缓存放在 dist 内）；清理 |
| `npm run start:dev` / `start:prod` | 开发 watch / 生产 `node dist/main.js` |
| `npm run migration:run` / `migration:show` / `migration:revert` | 迁移三连 |
| `npm test` | 单元测试（37 项，不需要数据库） |
| `node scripts/e2e-round2.cjs` | **端到端自验**（64 项，需先起服务与数据库） |
| `node scripts/probe-mysql.cjs` | 探测目标 MySQL 版本 / 排序规则 / 已有表 |
| `npm run lint` | ESLint |

---

## 关键约定（改动前务必读）

1. **金额一律整数「分」**，字段名统一 `*_cents`；时间统一存 UTC（`DATETIME(3)`），展示层再转本地。
2. **响应恒为** `{ code, message, data }`，HTTP 状态码 200（404/405 除外）。业务码见 `src/common/error-code.ts`，**禁止散落魔法数字**。
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
8. **门户不直连任何产品数据库**；跨系统只走契约里的 HTTP 接口（内网 + `X-Internal-Key`）。
9. **内网接口不对公网暴露**（契约附录自检项）：`/api/wallet/deduct`、`/api/wallet/refund` 只靠密钥鉴权，必须由防火墙/nginx 限制来源。
10. 密钥、密码、AK **不进仓库**：`.env` 与 `keys/` 已被 `.gitignore` 忽略。

## 环境要求与坑

| 项 | 说明 |
|---|---|
| Node | ≥ 20（用到 `process.loadEnvFile`，免 dotenv 依赖）。本仓库在 Node 24 上验证 |
| MySQL | **5.7 与 8.0 均可**（实测 5.7.26 通过）。排序规则固定 `utf8mb4_general_ci` |
| Redis | 5.0+（用到 `INCR`/`EXPIRE`/`TTL`/`SET EX`/`SCAN`/`SADD`/`SMEMBERS`/`SREM`）。Redis 不可用时登录/注册会失败，而限流与吊销查询**降级放行**（可用性优先） |
| argon2 | 原生模块，安装时需编译。受限环境可用 `npm install --ignore-scripts` 装依赖做类型检查，但**运行时加载会失败** |

> ⚠️ **字符集坑（已踩并修）**：迁移里别写 `utf8mb4_0900_ai_ci`（MySQL 8.0 专属）。在 5.7 上它**不报错**，而是静默降级成 `utf8mb4_general_ci`，导致不同环境实际排序规则不一致。现统一用 `utf8mb4_general_ci`。

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
│  ├─ internal-key.guard.ts    # 契约 §4 内网 X-Internal-Key
│  ├─ admin.guard.ts           # 契约 §6 管理端 X-Admin-Key
│  ├─ rate-limiter.service.ts  # Redis 固定窗口限流（故障降级放行）
│  ├─ redis.{constants,provider,module,store}.ts
│  ├─ crypto.util.ts           # uuidv7 / randomToken / sha256 / safeEqual
│  └─ request.util.ts          # Bearer 解析 / 客户端 IP
├─ config/
│  ├─ configuration.ts         # 环境变量 → 类型化配置
│  ├─ portal-config.service.ts
│  └─ token.module.ts          # JWT 签发（RS256；缺私钥启动即失败）
├─ database/
│  ├─ entities.ts              # 9 张表实体清单（连接与迁移共用）
│  ├─ data-source.ts           # TypeORM CLI / 迁移专用
│  └─ migrations/1759600000000-InitPortalSchema.ts
└─ modules/
   ├─ auth/                    # §1 认证 + JWKS（password / token / jwks service）
   ├─ wallet/                  # §3 钱包 + §6 管理端（wallet-ledger 是资金唯一入口）
   ├─ internal/                # §4 内网计费（deduct / refund）
   ├─ user/                    # u_user 实体
   ├─ product/                 # p_product / 同步日志（第 3 轮用）
   ├─ order/                   # o_order / o_order_item（第 3 轮用）
   └─ reconciliation/          # r_reconciliation（第 3 轮用）
scripts/                       # 密钥生成 / MySQL 探测 / 端到端自验
docker-compose.yml             # 本地 MySQL 8 + Redis 7
```
