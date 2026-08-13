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
  /** 密钥对象数组（含 enabled/errorCount 等元数据），与 apiKeys 同源 */
  apiKeyObjects?: PlatformApiKeyObject[];
  type: PlatformType;
  enabled: boolean;
  priority: number;
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 透传给上游的下游请求头白名单（JSON 字符串数组） */
  forwardHeaders: string;
  /** 流式请求时是否向请求体注入 stream_options:{include_usage:true}；部分严格后端（Mistral 等）拒绝未知字段，平台需手动关闭 */
  injectStreamOptions?: boolean;
  status: PlatformStatus;
  failCount: number;
  lastFailAt: number | null;
  cooldownEnd: number | null;
  /** 创建时间（Unix 秒时间戳） */
  createdAt?: number;
  /** 更新时间（Unix 秒时间戳） */
  updatedAt?: number;
}

/** 密钥对象（含元数据） */
export interface PlatformApiKeyObject {
  name: string;
  key: string;
  whitelisted?: boolean;
  enabled?: boolean;
  errorCount?: number;
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
