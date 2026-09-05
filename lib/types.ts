// ================================================================
// 共享 TypeScript 类型
// ================================================================

// ==================== 平台类型 ====================

/** openai = OpenAI 兼容协议（默认）；anthropic = 上游 Anthropic 协议（/v1/messages）；gemini = 上游 Gemini 原生协议（:generateContent） */
export type PlatformType = "openai" | "azure" | "custom" | "anthropic" | "gemini";

/**
 * 单平台多协议支持的协议枚举。与 PlatformType 同义，仅用于类型语义区分
 * （「支持的协议」vs「首选/兼容协议」）。数组 types[] 即由此枚举组成。
 */
export type PlatformProtocol = PlatformType;

export type PlatformStatus = "healthy" | "degraded" | "down";

/**
 * 解析平台支持的协议列表（types JSON 字符串）。
 *
 * 行为契约：
 * - 缺失/空字符串/JSON 解析失败 → 回退到 [type]（保持向后兼容，旧数据无 types 列）
 * - 全非法元素 → 回退到 [type]（fail-closed：避免下游误以为「无协议」导致路由失败）
 * - 去重并保持原顺序；type 永远保证出现在结果里（即便 types 中未列出）
 * - 非法元素被静默丢弃（不抛错，导入/迁移容错）
 */
export function resolvePlatformProtocols(
  typesJson: string | null | undefined,
  fallbackType: PlatformType
): PlatformProtocol[] {
  const result: PlatformProtocol[] = [];
  const seen = new Set<PlatformProtocol>();
  const push = (p: PlatformProtocol) => {
    if (!seen.has(p)) {
      seen.add(p);
      result.push(p);
    }
  };
  push(fallbackType);
  if (typesJson && typesJson.trim()) {
    try {
      const parsed = JSON.parse(typesJson);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (
            item === "openai" ||
            item === "azure" ||
            item === "custom" ||
            item === "anthropic" ||
            item === "gemini"
          ) {
            push(item);
          }
        }
      }
    } catch {
      // 容错：JSON 异常时回退到 [type]
    }
  }
  return result;
}

export interface PlatformConfig {
  id: string;
  name: string;
  baseUrl: string;
  /** 平台 API 密钥数组（命名对象 [{name, key, whitelisted}] 的 key 值），round-robin 轮询 */
  apiKeys: string[];
  /** 密钥对象数组（含 enabled/errorCount 等元数据），与 apiKeys 同源 */
  apiKeyObjects?: PlatformApiKeyObject[];
  /** 首选/兼容协议。types 缺失/为空时所有下游请求都走 type；types 非空时 type 必须 === types[0]（保存时由 API 强制对齐） */
  type: PlatformType;
  /**
   * 平台支持的协议列表（按用户偏好顺序排列）。首项即首选协议，必须 === type。
   *
   * 旧数据（无 types 列）会被 router/读路径解析为 [type]，行为不变。
   * 三端代理按下游端点（/v1/messages → anthropic，/v1/chat|responses → openai，gemini 模型 → gemini）
   * 在 types 内挑第一个匹配项；无匹配则回退 types[0] = type。
   */
  types?: PlatformProtocol[];
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
  /** 本次限流检查所用固定窗口的起点（毫秒，即扣减所在窗口键），供跨分钟
   *  边界回滚时定位原窗口桶。双端四函数走窗口键的全部分支（放行+拒绝）
   *  均返回；未触发窗口计数（如 limit 为 null 或 tokenCount<=0）时不
   *  返回 */
  windowStart?: number;
}

// ==================== 熔断器类型 ====================

export type CircuitBreakerState = "closed" | "open" | "half-open";
