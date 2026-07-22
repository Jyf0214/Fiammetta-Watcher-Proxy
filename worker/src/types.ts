/**
 * Worker 内部类型定义
 *
 * 包含平台配置、路由决策、速率限制结果等 Worker 专用类型。
 * 与 lib/types.ts 的共享类型区分，此处为 Worker 运行时特有。
 */

// ==================== 平台配置（缓存用） ====================

export interface PlatformConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeys: string[];
  type: "openai" | "azure" | "custom";
  enabled: boolean;
  priority: number;
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  forwardHeaders: string;
  status: "healthy" | "degraded" | "down";
  failCount: number;
  lastFailAt: number | null;
  cooldownEnd: number | null;
}

// ==================== 路由决策 ====================

export interface RouteDecision {
  platform: PlatformConfig;
  targetModel: string;
}

// ==================== 模型映射配置（缓存用） ====================

export interface ModelMapConfig {
  id: string;
  alias: string;
  targetModel: string;
  platformId: string | null;
}

// ==================== API Key（查询结果） ====================

export interface ApiKeyRecord {
  id: string;
  key: string;
  name: string;
  enabled: number;
  quota: number | null;
  usedTokens: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  callLimit: number | null;
  callUsed: number;
  resetPeriod: string | null;
  expiresAt: number | null;
  status: string;
}

// ==================== 速率限制结果 ====================

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

// ==================== 熔断器状态 ====================

export type CircuitBreakerState = "closed" | "open" | "half-open";

// ==================== Cron 任务类型 ====================

export type CronTask = "model-fetch" | "key-reset" | "log-archive";

/** 将 cron 表达式映射到任务类型 */
export function classifyCronExpression(cron: string): CronTask | null {
  // 每 10 分钟 → 模型发现
  if (cron.includes("*/10")) return "model-fetch";
  // 每小时 → Key 重置
  if (cron.includes("*/1 * * *")) return "key-reset";
  // 每天凌晨 3 点 → 日志归档
  if (cron.includes("0 3 * * *")) return "log-archive";
  return null;
}
