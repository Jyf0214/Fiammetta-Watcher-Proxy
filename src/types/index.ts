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
  status: PlatformStatus;
  failCount: number;
  lastFailAt: Date | null;
  cooldownEnd: Date | null;
  /** 创建时间（Prisma 查询未 select 时不存在） */
  createdAt?: Date;
  /** 更新时间（Prisma 查询未 select 时不存在） */
  updatedAt?: Date;
}

// ==================== API Key 类型 ====================

export type ApiKeyStatus = "active" | "disabled" | "expired";

export type ResetPeriod = "monthly" | "daily" | "never";

export interface ApiKeyConfig {
  id: string;
  key: string;
  name: string;
  planId: string | null;
  /** Decimal 类型，Prisma Client 返回 Decimal 对象，JSON 序列化后为字符串 */
  quota: string | null;
  /** BigInt 类型，JSON 序列化后为字符串 */
  usedTokens: bigint;
  rpmLimit: number | null;
  tpmLimit: number | null;
  callLimit: number | null;
  /** BigInt 类型，JSON 序列化后为字符串 */
  tokenLimit: bigint | null;
  resetPeriod: ResetPeriod;
  status: ApiKeyStatus;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ==================== 套餐类型 ====================

export interface PlanConfig {
  id: string;
  name: string;
  /** BigInt 类型，JSON 序列化后为字符串 */
  tokenQuota: bigint;
  callLimit: number;
  rpmLimit: number;
  tpmLimit: number;
  resetPeriod: ResetPeriod;
  createdAt: Date;
  updatedAt: Date;
}

// ==================== 模型映射类型 ====================

export interface ModelMapConfig {
  id: string;
  alias: string;
  targetModel: string;
  platformId: string | null;
  /** 创建时间（Prisma 查询未 select 时不存在） */
  createdAt?: Date;
  /** 更新时间（Prisma 查询未 select 时不存在） */
  updatedAt?: Date;
}

// ==================== 审计日志类型 ====================

export interface AuditLog {
  id: string;
  adminId: string | null;
  /** 操作类型（login, create_platform, update_key 等） */
  action: string;
  /** 操作详情（JSON 字符串） */
  detail: string | null;
  ip: string | null;
  createdAt: Date;
}

// ==================== 系统事件类型 ====================

export interface SystemEvent {
  id: string;
  /** 事件级别：info | warning | error | critical */
  level: string;
  message: string;
  /** 详细信息（JSON 字符串） */
  detail: string | null;
  createdAt: Date;
}

// ==================== 系统配置类型 ====================

export interface Config {
  id: string;
  key: string;
  value: string;
  updatedAt: Date;
}

// ==================== 路由决策类型 ====================

export interface RouteDecision {
  platform: PlatformConfig;
  targetModel: string;
}

// ==================== 请求日志类型 ====================

export interface RequestLogEntry {
  keyId: string | null;
  platformId: string | null;
  model: string;
  status: number;
  tokens: number;
  duration: number;
  isError: boolean;
  errorMessage: string | null;
  createdAt: Date;
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
  failureThreshold: number; // 触发熔断的连续失败次数
  cooldownMs: number; // 熔断冷却时间（毫秒）
  halfOpenMaxAttempts: number; // 半开状态最大尝试次数
}

// ==================== 通知类型 ====================

export type NotificationLevel = "info" | "warning" | "error" | "critical";

export interface NotificationMessage {
  level: NotificationLevel;
  title: string;
  content: string;
  timestamp: Date;
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
