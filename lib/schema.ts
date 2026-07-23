// ================================================================
// Drizzle ORM — SQLite 表定义（Cloudflare D1）
// 从 main 分支 Prisma schema 迁移
// ================================================================

import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// ==================== 管理员账户 ====================

export const admins = sqliteTable("admins", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer("updated_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
});

// ==================== 上游平台 ====================

export const platforms = sqliteTable("platforms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  apiKeys: text("api_keys").notNull().default("[]"),
  type: text("type").notNull().default("openai"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  priority: integer("priority").notNull().default(0),
  weight: integer("weight").notNull().default(1),
  rpmLimit: integer("rpm_limit"),
  tpmLimit: integer("tpm_limit"),
  status: text("status").notNull().default("healthy"),
  failCount: integer("fail_count").notNull().default(0),
  lastFailAt: integer("last_fail_at", { mode: "number" }),
  cooldownEnd: integer("cooldown_end", { mode: "number" }),
  forwardHeaders: text("forward_headers").notNull().default("[]"),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer("updated_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
}, (t) => [
  index("idx_platforms_enabled_status").on(t.enabled, t.status),
]);

// ==================== 代理池 ====================

export const proxyPools = sqliteTable("proxy_pools", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer("updated_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
});

// ==================== 代理 ====================

export const proxies = sqliteTable("proxies", {
  id: text("id").primaryKey(),
  address: text("address").notNull(),
  poolId: text("pool_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  status: text("status").notNull().default("healthy"),
  failCount: integer("fail_count").notNull().default(0),
  banCount: integer("ban_count").notNull().default(0),
  lastFailAt: integer("last_fail_at", { mode: "number" }),
  cooldownEnd: integer("cooldown_end", { mode: "number" }),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer("updated_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
}, (t) => [
  index("idx_proxies_pool_enabled").on(t.poolId, t.enabled, t.status),
]);

// ==================== 套餐模板 ====================

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  tokenQuota: integer("token_quota").notNull().default(0),
  callLimit: integer("call_limit").notNull().default(0),
  rpmLimit: integer("rpm_limit").notNull().default(0),
  tpmLimit: integer("tpm_limit").notNull().default(0),
  resetPeriod: text("reset_period").notNull().default("monthly"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer("updated_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
});

// ==================== API 密钥 ====================

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  planId: text("plan_id"),
  quota: real("quota"),
  usedTokens: integer("used_tokens").notNull().default(0),
  tokenLimit: integer("token_limit"),
  rpmLimit: integer("rpm_limit"),
  tpmLimit: integer("tpm_limit"),
  callLimit: integer("call_limit"),
  callUsed: integer("call_used").notNull().default(0),
  resetPeriod: text("reset_period").default("monthly"),
  status: text("status").notNull().default("active"),
  expiresAt: integer("expires_at", { mode: "number" }),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer("updated_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
}, (t) => [
  index("idx_api_keys_key").on(t.key),
  index("idx_api_keys_status_expires").on(t.status, t.expiresAt),
]);

// ==================== 系统 API 密钥（管理后台专用，不可用于 v1 代理） ====================

export const systemApiKeys = sqliteTable("system_api_keys", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastUsedAt: integer("last_used_at", { mode: "number" }),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer("updated_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
}, (t) => [
  index("idx_system_api_keys_key").on(t.key),
]);

// ==================== 模型映射 ====================

export const modelMappings = sqliteTable("model_maps", {
  id: text("id").primaryKey(),
  alias: text("alias").notNull(),
  targetModel: text("target_model").notNull(),
  platformId: text("platform_id"),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer("updated_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
}, (t) => [
  uniqueIndex("idx_model_maps_alias_platform").on(t.alias, t.platformId),
]);

// ==================== 平台模型（自动发现） ====================

export const platformModels = sqliteTable("platform_models", {
  id: text("id").primaryKey(),
  platformId: text("platform_id").notNull(),
  modelId: text("model_id").notNull(),
  ownedBy: text("owned_by"),
  modelName: text("model_name"),
  type: text("type").notNull().default("chat"),
  source: text("source").notNull().default("auto"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  fetchedAt: integer("fetched_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
}, (t) => [
  uniqueIndex("idx_platform_models_platform_model").on(t.platformId, t.modelId),
  index("idx_platform_models_platform_id").on(t.platformId),
  index("idx_platform_models_model_id").on(t.modelId),
]);

// ==================== 请求日志 ====================

export const requestLogs = sqliteTable("request_logs", {
  id: text("id").primaryKey(),
  keyId: text("key_id"),
  keyName: text("key_name"),
  platformId: text("platform_id"),
  proxyId: text("proxy_id"),
  model: text("model").notNull(),
  endpoint: text("endpoint"),
  method: text("method"),
  status: integer("status").notNull(),
  latency: integer("latency").notNull().default(0),
  tokens: integer("tokens").notNull().default(0),
  promptTokens: integer("prompt_tokens").notNull().default(0),
  completionTokens: integer("completion_tokens").notNull().default(0),
  ttft: integer("ttft").notNull().default(0),
  cost: real("cost").notNull().default(0),
  isError: integer("is_error", { mode: "boolean" }).notNull().default(false),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
}, (t) => [
  index("idx_request_logs_key_id").on(t.keyId),
  index("idx_request_logs_platform_id").on(t.platformId),
  index("idx_request_logs_created_at").on(t.createdAt),
  index("idx_request_logs_key_created").on(t.keyId, t.createdAt),
  index("idx_request_logs_platform_created").on(t.platformId, t.createdAt),
]);

// ==================== 每日统计（30天前自动归档） ====================

export const dailyStats = sqliteTable("daily_stats", {
  id: text("id").primaryKey(),
  date: integer("date").notNull(),
  keyId: text("key_id"),
  keyName: text("key_name"),
  platformId: text("platform_id"),
  platformName: text("platform_name"),
  model: text("model").notNull(),
  totalRequests: integer("total_requests").notNull().default(0),
  errorRequests: integer("error_requests").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  totalPromptTokens: integer("total_prompt_tokens").notNull().default(0),
  totalCompletionTokens: integer("total_completion_tokens").notNull().default(0),
  avgTtft: real("avg_ttft").notNull().default(0),
  avgDuration: real("avg_duration").notNull().default(0),
  maxTtft: integer("max_ttft").notNull().default(0),
  maxDuration: integer("max_duration").notNull().default(0),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
}, (t) => [
  uniqueIndex("idx_daily_stats_date_key_model").on(t.date, t.keyId, t.model),
  index("idx_daily_stats_date").on(t.date),
  index("idx_daily_stats_key_date").on(t.keyId, t.date),
  index("idx_daily_stats_platform_date").on(t.platformId, t.date),
]);

// ==================== 系统配置 ====================

export const configs = sqliteTable("configs", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
});

// ==================== 系统事件 ====================

export const systemEvents = sqliteTable("system_events", {
  id: text("id").primaryKey(),
  level: text("level").notNull(),
  message: text("message").notNull(),
  detail: text("detail"),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
}, (t) => [
  index("idx_system_events_level").on(t.level),
  index("idx_system_events_created_at").on(t.createdAt),
]);

// ==================== 审计日志 ====================

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  adminId: text("admin_id"),
  action: text("action").notNull(),
  detail: text("detail"),
  ip: text("ip"),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
}, (t) => [
  index("idx_audit_logs_admin_id").on(t.adminId),
  index("idx_audit_logs_created_at").on(t.createdAt),
]);

// ==================== 请求模板 ====================

export const requestTemplates = sqliteTable("request_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  method: text("method").notNull().default("POST"),
  endpoint: text("endpoint").notNull().default("all"),
  headers: text("headers").notNull().default("{}"),
  bodyTemplate: text("body_template"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
  updatedAt: integer("updated_at", { mode: "number" }).notNull().$defaultFn(() => Math.floor(Date.now() / 1000)),
});

// ==================== snake_case 别名（兼容已有路由） ====================
// 部分路由（如 Agent D1）使用 schema.audit_logs、schema.model_mappings 等命名
// 同一个 Drizzle 表对象可被两种命名引用，不影响运行

export const audit_logs = auditLogs;
export const request_logs = requestLogs;
export const model_mappings = modelMappings;
export const platform_models = platformModels;
export const proxy_pools = proxyPools;
export const system_events = systemEvents;
export const daily_stats = dailyStats;
export const api_keys = apiKeys;
