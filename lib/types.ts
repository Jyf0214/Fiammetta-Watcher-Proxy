// ================================================================
// 共享 TypeScript 类型
// 从 main 分支 src/types/index.ts 迁移
// 转换规则：Date→number(Unix时间戳), Decimal→number, BigInt→number
// ================================================================

// ==================== 平台类型 ====================

export type PlatformType = "openai" | "azure" | "custom";

export type PlatformStatus = "healthy" | "degraded" | "down";

export interface PlatformConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 附加密钥 JSON 数组，与主密钥一起轮询 */
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

// ==================== API Key 类型 ====================

export type ApiKeyStatus = "active" | "disabled" | "expired";

export type ResetPeriod = "monthly" | "daily" | "never";

export interface ApiKeyConfig {
  id: string;
  key: string;
  name: string;
  planId: string | null;
  /** 额度（REAL 类型，D1 返回 number） */
  quota: number | null;
  /** 已使用 token 数 */
  usedTokens: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  callLimit: number | null;
  /** 总 token 限制（null 表示使用 Plan 默认值） */
  tokenLimit: number | null;
  callUsed: number;
  resetPeriod: ResetPeriod;
  status: ApiKeyStatus;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ==================== 套餐类型 ====================

export interface PlanConfig {
  id: string;
  name: string;
  /** 总 token 额度 */
  tokenQuota: number;
  callLimit: number;
  rpmLimit: number;
  tpmLimit: number;
  resetPeriod: ResetPeriod;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
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

// ==================== 平台模型类型 ====================

export type PlatformModelType = "chat" | "image" | "audio" | "embedding";

export type PlatformModelSource = "auto" | "manual";

export interface PlatformModelConfig {
  id: string;
  platformId: string;
  modelId: string;
  ownedBy: string | null;
  modelName: string | null;
  type: PlatformModelType;
  source: PlatformModelSource;
  fetchedAt: number;
}

// ==================== 审计日志类型 ====================

export interface AuditLogEntry {
  id: string;
  adminId: string | null;
  /** 操作类型（login, create_platform, update_key 等） */
  action: string;
  /** 操作详情（JSON 字符串） */
  detail: string | null;
  ip: string | null;
  createdAt: number;
}

// ==================== 系统事件类型 ====================

export type EventLevel = "info" | "warning" | "error" | "critical";

export interface SystemEventEntry {
  id: string;
  level: EventLevel;
  message: string;
  /** 详细信息（JSON 字符串） */
  detail: string | null;
  createdAt: number;
}

// ==================== 系统配置类型 ====================

export interface ConfigEntry {
  key: string;
  value: string;
  updatedAt: number;
}

// ==================== 请求模板类型 ====================

export interface RequestTemplateEntry {
  id: string;
  name: string;
  description: string | null;
  method: string;
  endpoint: string;
  headers: string;
  bodyTemplate: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 运行时使用的请求模板（已解析 JSON 字段） */
export interface RequestTemplate {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  mergeBody: Record<string, unknown>;
  enabled: boolean;
}

// ==================== 路由决策类型 ====================

export interface RouteDecision {
  platform: PlatformConfig;
  targetModel: string;
}

// ==================== 请求日志类型 ====================

export interface RequestLogEntry {
  id: string;
  keyId: string | null;
  apiKeyName: string | null;
  platformId: string | null;
  model: string;
  endpoint: string | null;
  method: string | null;
  status: number;
  latency: number;
  tokens: number;
  tokensPrompt: number;
  tokensCompletion: number;
  ttft: number;
  duration: number;
  cost: number;
  isError: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  errorMessage: string | null;
  createdAt: number;
}

// ==================== 每日统计类型 ====================

export interface DailyStatsEntry {
  id: string;
  date: number;
  keyId: string | null;
  keyName: string | null;
  platformId: string | null;
  platformName: string | null;
  model: string;
  totalRequests: number;
  errorRequests: number;
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  avgTtft: number;
  avgDuration: number;
  maxTtft: number;
  maxDuration: number;
  createdAt: number;
}

// ==================== 速率限制类型 ====================

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

// ==================== 熔断器类型 ====================

export type CircuitBreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** 触发熔断的连续失败次数 */
  failureThreshold: number;
  /** 熔断冷却时间（毫秒） */
  cooldownMs: number;
  /** 半开状态最大尝试次数 */
  halfOpenMaxAttempts: number;
}

// ==================== 通知类型 ====================

export type NotificationLevel = "info" | "warning" | "error" | "critical";

export interface NotificationMessage {
  level: NotificationLevel;
  title: string;
  content: string;
  timestamp: number;
}

// ==================== API 响应类型 ====================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ==================== OpenAI 兼容类型 ====================

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant" | "function" | "tool";
    content: string | null;
    name?: string;
    function_call?: { name: string; arguments: string };
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  n?: number;
}

export interface CompletionRequest {
  model: string;
  prompt: string | string[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  n?: number;
}
