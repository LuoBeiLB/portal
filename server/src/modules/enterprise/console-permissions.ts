/**
 * 管理端权限点（一期**硬编码**，不建权限表）。
 *
 * 依据 v2 设计稿 §5：菜单、路由、按钮统一由后端下发的白名单驱动，
 * 前端不再做"角色探测"。
 *
 * ⚠️ 这套 `platform.* / enterprise.*` 只服务于**门户管理端**的菜单可见性，
 * 与云存储的企业 RBAC（40 个权限点、角色可自定义）**完全无关**，不要混。
 * 那边是产品内的功能授权，这里是"门户控制台你看到哪些菜单"。
 */

/** 平台管理员：全量 */
export const PLATFORM_PERMISSIONS = [
  /** 概览（登录即可，但仍列出来让前端菜单有统一判断依据） */
  'platform.dashboard.read',
  /** 企业审核：通过 / 驳回 */
  'platform.enterprise.review',
  /** 企业管理：停用 / 恢复 / 代客建 */
  'platform.enterprise.manage',
  /** 用户管理：按企业、账号性质筛选，禁用个人用户 */
  'platform.user.manage',
  /** 充值核销 */
  'platform.recharge.confirm',
  /** 交易流水 */
  'platform.transaction.read',
  /** 导出流水（数据外泄面，单独一个点） */
  'platform.transaction.export',
  /** 日对账 */
  'platform.reconciliation.read',
  /** 操作日志 */
  'platform.audit.read',
  /** 管理员管理 */
  'platform.admin.manage',
] as const;

/**
 * 企业管理员：受限视图。
 *
 * 只有四个点。**刻意不给钱相关的能力**（充值/流水/对账/日志）：
 * 按企业维度过滤流水需要流水表加 `enterprise_id` 维度（docs/24 的 M4），
 * 过早开放只会给出错误的数字。
 */
export const ENTERPRISE_PERMISSIONS = [
  /** 我的企业（只读） */
  'enterprise.profile.read',
  /** 员工列表 */
  'enterprise.member.read',
  /** 建员工 / 停用恢复 */
  'enterprise.member.write',
  /** 重置员工密码 */
  'enterprise.member.reset',
] as const;

export type ConsoleScope = 'platform' | 'enterprise';
