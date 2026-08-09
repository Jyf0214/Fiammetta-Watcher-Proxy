// ================================================================
// 共享 TypeScript 类型
// ================================================================

// ==================== 平台类型 ====================

export type PlatformType = "openai" | "azure" | "custom";

export type PlatformStatus = "healthy" | "degraded" | "down";

export interface PlatformConfig {
  id: string;
  name: string;
  baseUrl: string;
  /** 平台 API 密钥数组（命名对象 [{name, key, whitelisted}] 的 key 值），round-robin 轮询 */
  apiKeys: string[];
  type: PlatformType;
  enabled: boolean;
  priority: number;
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 透传给上游的下游请求头白名单（JSON 字符串数组） */
  forwardHeaders: string;
  status: PlatformStatus;
  failCount: number;
  lastFailAt: number | null;
  cooldownEnd: number | null;
  /** 创建时间（Unix 秒时间戳） */
  createdAt?: number;
  /** 更新时间（Unix 秒时间戳） */
  updatedAt?: number;
}

// ==================== 模型映射类型 ====================

export interface ModelMapConfig {
  id: string;
  alias: string;
  targetModel: string;
  platformId: string | null;
  createdAt?: number;
  updatedAt?: number;
}

// ==================== 路由决策类型 ====================

export interface RouteDecision {
  platform: PlatformConfig;
  targetModel: string;
}

// ==================== 速率限制类型 ====================

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

// ==================== 熔断器类型 ====================

export type CircuitBreakerState = "closed" | "open" | "half-open";
