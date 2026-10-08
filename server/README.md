# cloud-portal · 服务端

云平台统一门户服务端（NestJS 10 + TypeORM + MySQL 8 + Redis 7）。

> **上游依据**：《云平台统一门户 API 契约 v1.0》（2026-09-30 定稿），见工作区 `docs/original/云平台统一门户_API契约.md`
> **设计方案**：`docs/04-门户下一版方案_架构与ER.md`（架构 + 表结构 + 改造清单）
> **已拍板**：独立门户计费 · NestJS + Vue 3 + MySQL · 云存储先接入，桌面/云手机后续

---

## 当前进度（第 1 轮：地基）

| 内容 | 状态 |
|---|---|
| 工程骨架（nest-cli / tsconfig / eslint / prettier） | ✅ |
| 配置装载（`.env`、密钥文件、产品端点、退避参数） | ✅ |
| 9 张表的 TypeORM 实体 | ✅ |
| 建表迁移 `InitPortalSchema` | ✅ |
| 统一响应包装 + 全局异常过滤（契约 §0.2 / §0.6） | ✅ |
| 探活 `/api/healthz`、元信息 `/api/meta` | ✅ |
| 单元测试 10 条（响应形态、配置解析） | ✅ |
| 本地起库 `docker-compose.yml` | ✅ |

**尚未实现**（后续轮次）：auth（注册/登录/refresh/登出/JWKS）、wallet（余额/流水/充值申请/核销）、product（目录同步）、order（下单/支付/退款）、internal（deduct/refund）、admin、对账任务、前端。

---

## 快速开始

```bash
# 1) 装依赖（argon2 是原生模块，需要编译；Windows 需 VS Build Tools）
npm install

# 2) 生成 JWT RS256 密钥（写入 keys/，已在 .gitignore）
npm run keys:generate

# 3) 配置环境变量
cp .env.example .env
#   按提示填 DB_PASSWORD / ADMIN_KEY / PRODUCT_*_INTERNAL_KEY 等

# 4) 起本地 MySQL + Redis
docker compose up -d

# 5) 建表（迁移纪律：一律 migration:run，不使用 synchronize）
npm run migration:run

# 6) 启动
npm run start:dev
curl http://127.0.0.1:3000/api/healthz   # {"code":0,"message":"ok","data":{"status":"ok",...}}
```

## 常用脚本

| 命令 | 说明 |
|---|---|
| `npm run build` | 编译到 `dist/`（增量缓存放在 dist 内，避免残留） |
| `npm run clean` | 清 `dist` 与增量缓存 |
| `npm run start:dev` | 开发模式（watch） |
| `npm run start:prod` | 生产启动 `node dist/main.js` |
| `npm run migration:run` / `migration:show` / `migration:revert` | 迁移三连 |
| `npm test` | 单元测试（不需要数据库） |
| `npm run lint` | ESLint |
| `npm run keys:generate -- --inline` | 打印内联 PEM（仅本地开发用） |

---

## 关键约定（改动前务必读）

1. **金额一律整数「分」**，字段名统一 `*_cents`；展示层再除 100。时间统一存 UTC（`DATETIME(3)`）。
2. **响应恒为** `{ code, message, data }`，HTTP 状态码 200（404/405 除外）。业务码见 `src/common/error-code.ts`，**禁止散落魔法数字**。
3. **幂等**：`bill_no`（钱包流水，唯一索引）、`order_item_id`（订单项主键 = 产品 provision 幂等键）。先落库生成单号，再发请求。
4. **钱包扣费只走条件原子更新**：
   ```sql
   UPDATE w_wallet SET balance_cents = balance_cents - ?
    WHERE user_id = ? AND status = 0 AND balance_cents >= ?
   ```
   影响行数 = 0 即余额不足/冻结；因此钱包表**不设 version 乐观锁列**。
5. **用户 ID 全系统统一 `CHAR(36)`**（UUIDv7 字符串），不做 `BINARY(16)` 转换 —— JWT 的 `sub`、产品侧 `portal_user_map.portal_user_id` 都是这 36 位。
6. **门户不直连任何产品数据库**；跨系统只走契约里的 HTTP 接口（内网 + `X-Internal-Key`）。
7. **`portal_user_map` 与 `b_bill` 属于产品库**，不建在门户库。
8. 密钥、密码、AK **不进仓库**：`.env` 与 `keys/` 已被 `.gitignore` 忽略。

## 目录结构

```
src/
├─ main.ts                     # 引导：全局前缀 /api、cookie、响应拦截、异常过滤、校验管道
├─ app.module.ts               # 根模块（配置 + TypeORM）
├─ app.controller.ts           # /api/healthz、/api/meta
├─ common/
│  ├─ error-code.ts            # 契约 §0.6 错误码 + BizException
│  ├─ response.interceptor.ts  # 契约 §0.2 统一响应
│  ├─ all-exceptions.filter.ts # 业务失败也返回 HTTP 200
│  └─ base.entity.ts
├─ config/
│  ├─ configuration.ts         # 环境变量 → 类型化配置
│  └─ portal-config.service.ts # 注入用访问入口
├─ database/
│  ├─ entities.ts              # 9 张表实体清单（连接与迁移共用）
│  ├─ data-source.ts           # TypeORM CLI / 迁移专用
│  └─ migrations/1759600000000-InitPortalSchema.ts
└─ modules/
   ├─ user/                    # u_user
   ├─ wallet/                  # w_wallet、w_transaction、w_recharge_apply
   ├─ product/                 # p_product、p_product_sync_log
   ├─ order/                   # o_order、o_order_item
   └─ reconciliation/          # r_reconciliation
scripts/generate-jwt-keys.ts   # RS256 密钥生成
docker-compose.yml             # 本地 MySQL 8 + Redis 7
```

## 已知环境注意

- **`argon2` 是原生模块**：安装时需 postinstall 编译。若安装环境无法编译（例如受限沙箱），可用 `npm install --ignore-scripts` 装下依赖做类型检查，但**运行时会加载失败**，正式环境请确保能编译。
- Node 版本要求 ≥ 20（用到 `process.loadEnvFile`，免 dotenv 依赖）。本仓库在 Node 24 上验证通过。
- MySQL 时区按 UTC：`docker-compose.yml` 已加 `--default-time-zone=+00:00`。
