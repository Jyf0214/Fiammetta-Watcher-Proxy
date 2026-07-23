// ================================================================
// Drizzle ORM — MySQL 表定义
// 与 lib/schema.ts（SQLite/D1）结构完全一致，适配 MySQL 类型
// ================================================================

import { mysqlTable, varchar, int, double, boolean, text, index, uniqueIndex } from "drizzle-orm/mysql-core";

// ==================== 管理员账户 ====================

export const admins = mysqlTable("admins", {
  id: varchar("id", { length: 36 }).primaryKey(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  createdAt: int("created_at").notNull(),
  updatedAt: int("updated_at").notNull(),
});

// ==================== 上游平台 ====================

export const platforms = mysqlTable("platforms", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  baseUrl: varchar("base_url", { length: 500 }).notNull(),
  apiKey: varchar("api_key", { length: 500 }).notNull(),
  apiKeys: text("api_keys").notNull().default("[]"),
  type: varchar("type", { length: 20 }).notNull().default("openai"),
  enabled: boolean("enabled").notNull().default(true),
  priority: int("priority").notNull().default(0),
  weight: int("weight").notNull().default(1),
  rpmLimit: int("rpm_limit"),
  tpmLimit: int("tpm_limit"),
  status: varchar("status", { length: 20 }).notNull().default("healthy"),
  failCount: int("fail_count").notNull().default(0),
  lastFailAt: int("last_fail_at"),
  cooldownEnd: int("cooldown_end"),
  forwardHeaders: text("forward_headers").notNull().default("[]"),
  createdAt: int("created_at").notNull(),
  updatedAt: int("updated_at").notNull(),
}, (t) => [
  index("idx_platforms_enabled_status").on(t.enabled, t.status),
]);

// ==================== 代理池 ====================

export const proxyPools = mysqlTable("proxy_pools", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: int("created_at").notNull(),
  updatedAt: int("updated_at").notNull(),
});

// ==================== 代理 ====================

export const proxies = mysqlTable("proxies", {
  id: varchar("id", { length: 36 }).primaryKey(),
  address: varchar("address", { length: 500 }).notNull(),
  poolId: varchar("pool_id", { length: 36 }),
  enabled: boolean("enabled").notNull().default(true),
  status: varchar("status", { length: 20 }).notNull().default("healthy"),
  failCount: int("fail_count").notNull().default(0),
  banCount: int("ban_count").notNull().default(0),
  lastFailAt: int("last_fail_at"),
  cooldownEnd: int("cooldown_end"),
  createdAt: int("created_at").notNull(),
  updatedAt: int("updated_at").notNull(),
}, (t) => [
  index("idx_proxies_pool_enabled").on(t.poolId, t.enabled, t.status),
]);

// ==================== 套餐模板 ====================

export const plans = mysqlTable("plans", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  tokenQuota: int("token_quota").notNull().default(0),
  callLimit: int("call_limit").notNull().default(0),
  rpmLimit: int("rpm_limit").notNull().default(0),
  tpmLimit: int("tpm_limit").notNull().default(0),
  resetPeriod: varchar("reset_period", { length: 20 }).notNull().default("monthly"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: int("created_at").notNull(),
  updatedAt: int("updated_at").notNull(),
});

// ==================== API 密钥 ====================

export const apiKeys = mysqlTable("api_keys", {
  id: varchar("id", { length: 36 }).primaryKey(),
  key: varchar("key", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  planId: varchar("plan_id", { length: 36 }),
  quota: double("quota"),
  usedTokens: int("used_tokens").notNull().default(0),
  tokenLimit: int("token_limit"),
  rpmLimit: int("rpm_limit"),
  tpmLimit: int("tpm_limit"),
  callLimit: int("call_limit"),
  callUsed: int("call_used").notNull().default(0),
  resetPeriod: varchar("reset_period", { length: 20 }).default("monthly"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  expiresAt: int("expires_at"),
  createdAt: int("created_at").notNull(),
  updatedAt: int("updated_at").notNull(),
}, (t) => [
  index("idx_api_keys_key").on(t.key),
  index("idx_api_keys_status_expires").on(t.status, t.expiresAt),
]);

// ==================== 模型映射 ====================

export const modelMappings = mysqlTable("model_maps", {
  id: varchar("id", { length: 36 }).primaryKey(),
  alias: varchar("alias", { length: 255 }).notNull(),
  targetModel: varchar("target_model", { length: 255 }).notNull(),
  platformId: varchar("platform_id", { length: 36 }),
  createdAt: int("created_at").notNull(),
  updatedAt: int("updated_at").notNull(),
}, (t) => [
  uniqueIndex("idx_model_maps_alias_platform").on(t.alias, t.platformId),
]);

// ==================== 平台模型（自动发现） ====================

export const platformModels = mysqlTable("platform_models", {
  id: varchar("id", { length: 36 }).primaryKey(),
  platformId: varchar("platform_id", { length: 36 }).notNull(),
  modelId: varchar("model_id", { length: 255 }).notNull(),
  ownedBy: varchar("owned_by", { length: 255 }),
  modelName: varchar("model_name", { length: 255 }),
  type: varchar("type", { length: 20 }).notNull().default("chat"),
  source: varchar("source", { length: 20 }).notNull().default("auto"),
  enabled: boolean("enabled").notNull().default(true),
  fetchedAt: int("fetched_at").notNull(),
}, (t) => [
  uniqueIndex("idx_platform_models_platform_model").on(t.platformId, t.modelId),
  index("idx_platform_models_platform_id").on(t.platformId),
  index("idx_platform_models_model_id").on(t.modelId),
]);

// ==================== 请求日志 ====================

export const requestLogs = mysqlTable("request_logs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  keyId: varchar("key_id", { length: 36 }),
  keyName: varchar("key_name", { length: 100 }),
  platformId: varchar("platform_id", { length: 36 }),
  proxyId: varchar("proxy_id", { length: 36 }),
  model: varchar("model", { length: 255 }).notNull(),
  endpoint: varchar("endpoint", { length: 500 }),
  method: varchar("method", { length: 10 }),
  status: int("status").notNull(),
  latency: int("latency").notNull().default(0),
  tokens: int("tokens").notNull().default(0),
  promptTokens: int("prompt_tokens").notNull().default(0),
  completionTokens: int("completion_tokens").notNull().default(0),
  ttft: int("ttft").notNull().default(0),
  cost: double("cost").notNull().default(0),
  isError: boolean("is_error").notNull().default(false),
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  errorMessage: text("error_message"),
  createdAt: int("created_at").notNull(),
}, (t) => [
  index("idx_request_logs_key_id").on(t.keyId),
  index("idx_request_logs_platform_id").on(t.platformId),
  index("idx_request_logs_created_at").on(t.createdAt),
  index("idx_request_logs_key_created").on(t.keyId, t.createdAt),
  index("idx_request_logs_platform_created").on(t.platformId, t.createdAt),
]);

// ==================== 每日统计（30天前自动归档） ====================

export const dailyStats = mysqlTable("daily_stats", {
  id: varchar("id", { length: 36 }).primaryKey(),
  date: int("date").notNull(),
  keyId: varchar("key_id", { length: 36 }),
  keyName: varchar("key_name", { length: 100 }),
  platformId: varchar("platform_id", { length: 36 }),
  platformName: varchar("platform_name", { length: 100 }),
  model: varchar("model", { length: 255 }).notNull(),
  totalRequests: int("total_requests").notNull().default(0),
  errorRequests: int("error_requests").notNull().default(0),
  totalTokens: int("total_tokens").notNull().default(0),
  totalPromptTokens: int("total_prompt_tokens").notNull().default(0),
  totalCompletionTokens: int("total_completion_tokens").notNull().default(0),
  avgTtft: double("avg_ttft").notNull().default(0),
  avgDuration: double("avg_duration").notNull().default(0),
  maxTtft: int("max_ttft").notNull().default(0),
  maxDuration: int("max_duration").notNull().default(0),
  createdAt: int("created_at").notNull(),
}, (t) => [
  uniqueIndex("idx_daily_stats_date_key_model").on(t.date, t.keyId, t.model),
  index("idx_daily_stats_date").on(t.date),
  index("idx_daily_stats_key_date").on(t.keyId, t.date),
  index("idx_daily_stats_platform_date").on(t.platformId, t.date),
]);

// ==================== 系统配置 ====================

export const configs = mysqlTable("configs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  key: varchar("key", { length: 255 }).notNull().unique(),
  value: text("value").notNull(),
  updatedAt: int("updated_at").notNull(),
});

// ==================== 系统事件 ====================

export const systemEvents = mysqlTable("system_events", {
  id: varchar("id", { length: 36 }).primaryKey(),
  level: varchar("level", { length: 20 }).notNull(),
  message: varchar("message", { length: 500 }).notNull(),
  detail: text("detail"),
  createdAt: int("created_at").notNull(),
}, (t) => [
  index("idx_system_events_level").on(t.level),
  index("idx_system_events_created_at").on(t.createdAt),
]);

// ==================== 审计日志 ====================

export const auditLogs = mysqlTable("audit_logs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  adminId: varchar("admin_id", { length: 36 }),
  action: varchar("action", { length: 100 }).notNull(),
  detail: text("detail"),
  ip: varchar("ip", { length: 45 }),
  createdAt: int("created_at").notNull(),
}, (t) => [
  index("idx_audit_logs_admin_id").on(t.adminId),
  index("idx_audit_logs_created_at").on(t.createdAt),
]);

// ==================== 请求模板 ====================

export const requestTemplates = mysqlTable("request_templates", {
  id: varchar("id", { length: 36 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  description: varchar("description", { length: 500 }),
  method: varchar("method", { length: 10 }).notNull().default("POST"),
  endpoint: varchar("endpoint", { length: 100 }).notNull().default("all"),
  headers: text("headers").notNull().default("{}"),
  bodyTemplate: text("body_template"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: int("created_at").notNull(),
  updatedAt: int("updated_at").notNull(),
});

// ==================== snake_case 别名（兼容已有路由） ====================

export const audit_logs = auditLogs;
export const request_logs = requestLogs;
export const model_mappings = modelMappings;
export const platform_models = platformModels;
export const proxy_pools = proxyPools;
export const system_events = systemEvents;
export const daily_stats = dailyStats;
export const api_keys = apiKeys;
