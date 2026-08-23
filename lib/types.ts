// ================================================================
// 共享 TypeScript 类型
// ================================================================

// ==================== 平台类型 ====================

/** openai = OpenAI 兼容协议（默认）；anthropic = 上游 Anthropic 协议（/v1/messages） */
export type PlatformType = "openai" | "azure" | "custom" | "anthropic";

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
  /** 高级设置：是否使用自定义 User-Agent 覆盖默认请求头 */
  reuseUserAgent?: boolean;
  /** 自定义 User-Agent 字符串（reuseUserAgent 开启时生效），最长 500 字符 */
  customUserAgent?: string | null;
  /** 高级设置：自定义请求头（强制覆盖，JSON 键值对字符串），优先级高于下游透传头 */
  extraHeaders?: string | null;
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
  /** 密钥级代理绑定：指定该密钥使用的出站代理 URL（最多 2 个） */
  proxyUrls?: string[];
  /** 严格绑定模式：true=绑定代理不可用时返回 502；false=回退平台级代理（默认 true） */
  proxyStrict?: boolean;
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

export type ApiType = "chat" | "responses";

export interface RouteDecision {
  platform: PlatformConfig;
  targetModel: string;
  /** 下游来源 API（由请求端点决定） */
  sourceApi?: ApiType;
}

// ==================== 速率限制类型 ====================

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

// ==================== 熔断器类型 ====================

export type CircuitBreakerState = "closed" | "open" | "half-open";
