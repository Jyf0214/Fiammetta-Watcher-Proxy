/**
 * Drizzle ORM Schema — Cloudflare D1 (SQLite)
 *
 * 从原 Prisma schema (MySQL) 迁移而来。
 * SQLite 差异处理：
 * - BigInt → INTEGER (应用层转换)
 * - DateTime → TEXT (ISO 8601 字符串)
 * - Boolean → INTEGER (0/1)
 * - Decimal → REAL
 * - JSON 字段 → TEXT (序列化字符串)
 */

import { sqliteTable, text, integer, real, unique } from "drizzle-orm/sqlite-core";

// ==================== 管理员账户 ====================

export const admins = sqliteTable("admins", {
  id: text("id").primaryKey(),
  username: text("username").unique().notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ==================== 上游平台 ====================

export const platforms = sqliteTable("platforms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  apiKeys: text("api_keys").default("[]"), // JSON 数组
  type: text("type").default("openai"),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  priority: integer("priority").default(0),
  weight: integer("weight").default(1),
  rpmLimit: integer("rpm_limit"),
  tpmLimit: integer("tpm_limit"),
  status: text("status").default("healthy"),
  failCount: integer("fail_count").default(0),
  lastFailAt: text("last_fail_at"),
  cooldownEnd: text("cooldown_end"),
  forwardHeaders: text("forward_headers").default("[]"), // JSON 数组
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ==================== 代理池 ====================

export const proxyPools = sqliteTable("proxy_pools", {
  id: text("id").primaryKey(),
  name: text("name").unique().notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ==================== 代理 ====================

export const proxies = sqliteTable("proxies", {
  id: text("id").primaryKey(),
  address: text("address").notNull(),
  poolId: text("pool_id").references(() => proxyPools.id, { onDelete: "set null" }),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  status: text("status").default("healthy"),
  failCount: integer("fail_count").default(0),
  banCount: integer("ban_count").default(0),
  lastFailAt: text("last_fail_at"),
  cooldownEnd: text("cooldown_end"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ==================== API Key ====================

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  key: text("key").unique().notNull(),
  name: text("name").notNull(),
  planId: text("plan_id").references(() => plans.id),
  quota: real("quota"), // Decimal → REAL
  usedTokens: integer("used_tokens").default(0), // BigInt → INTEGER
  rpmLimit: integer("rpm_limit"),
  tpmLimit: integer("tpm_limit"),
  callLimit: integer("call_limit"),
  tokenLimit: integer("token_limit"), // BigInt → INTEGER
  resetPeriod: text("reset_period").default("monthly"),
  status: text("status").default("active"),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ==================== 套餐模板 ====================

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").unique().notNull(),
  tokenQuota: integer("token_quota").notNull(), // BigInt → INTEGER
  callLimit: integer("call_limit").notNull(),
  rpmLimit: integer("rpm_limit").notNull(),
  tpmLimit: integer("tpm_limit").notNull(),
  resetPeriod: text("reset_period").default("monthly"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ==================== 模型映射 ====================

export const modelMaps = sqliteTable("model_maps", {
  id: text("id").primaryKey(),
  alias: text("alias").notNull(),
  targetModel: text("target_model").notNull(),
  platformId: text("platform_id").references(() => platforms.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  unique().on(t.alias, t.platformId),
]);

// ==================== 平台模型（自动发现） ====================

export const platformModels = sqliteTable("platform_models", {
  id: text("id").primaryKey(),
  platformId: text("platform_id").notNull().references(() => platforms.id, { onDelete: "cascade" }),
  modelId: text("model_id").notNull(),
  ownedBy: text("owned_by"),
  type: text("type").default("chat"),
  source: text("source").default("auto"),
  fetchedAt: text("fetched_at").notNull(),
}, (t) => [
  unique().on(t.platformId, t.modelId),
]);

// ==================== 请求日志 ====================

export const requestLogs = sqliteTable("request_logs", {
  id: text("id").primaryKey(),
  keyId: text("key_id").references(() => apiKeys.id),
  platformId: text("platform_id").references(() => platforms.id),
  proxyId: text("proxy_id"),
  model: text("model").notNull(),
  status: integer("status").notNull(),
  tokens: integer("tokens").default(0),
  promptTokens: integer("prompt_tokens").default(0),
  completionTokens: integer("completion_tokens").default(0),
  ttft: integer("ttft").default(0),
  duration: integer("duration").default(0),
  isError: integer("is_error", { mode: "boolean" }).default(false),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
});

// ==================== 审计日志 ====================

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  adminId: text("admin_id").references(() => admins.id),
  action: text("action").notNull(),
  detail: text("detail"),
  ip: text("ip"),
  createdAt: text("created_at").notNull(),
});

// ==================== 系统事件 ====================

export const systemEvents = sqliteTable("system_events", {
  id: text("id").primaryKey(),
  level: text("level").notNull(),
  message: text("message").notNull(),
  detail: text("detail"),
  createdAt: text("created_at").notNull(),
});

// ==================== 系统配置 ====================

export const configs = sqliteTable("configs", {
  id: text("id").primaryKey(),
  key: text("key").unique().notNull(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ==================== 日志聚合统计 ====================

export const dailyStats = sqliteTable("daily_stats", {
  id: text("id").primaryKey(),
  date: text("date").notNull(), // ISO 日期字符串
  keyId: text("key_id"),
  keyName: text("key_name"),
  platformId: text("platform_id"),
  platformName: text("platform_name"),
  model: text("model").notNull(),
  totalRequests: integer("total_requests").default(0),
  errorRequests: integer("error_requests").default(0),
  totalTokens: integer("total_tokens").default(0),
  totalPromptTokens: integer("total_prompt_tokens").default(0),
  totalCompletionTokens: integer("total_completion_tokens").default(0),
  avgTtft: real("avg_ttft").default(0),
  avgDuration: real("avg_duration").default(0),
  maxTtft: integer("max_ttft").default(0),
  maxDuration: integer("max_duration").default(0),
}, (t) => [
  unique().on(t.date, t.keyId, t.model),
]);
