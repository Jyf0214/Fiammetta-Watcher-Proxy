/**
 * 三端代理共享常量与纯函数（proxy-core 第五块）
 *
 * worker/src/proxy.ts 全量版、worker/src/proxy-lite.ts lite 版、
 * pages/api/v1/[[...v1]].ts Pages 版此前各自重复定义了同一组超时/上限常量、
 * 透传黑名单集合、可重试状态集与 token 预估/退避公式，本模块固化为唯一定义，
 * 消除副本漂移（任一端调参其余两端不同步的历史问题）。
 *
 * EMPTY_UPSTREAM_RESPONSE 哨兵也在此单点定义：Symbol() 每次调用产生新值，
 * 「上游响应处理函数返回哨兵 → 调用方判定纳入重试」的两端必须引用同一实例。
 */

/** 上游请求总超时（等待响应头 + 非流式响应体） */
export const UPSTREAM_TIMEOUT_MS = 120_000;

/** 流式响应空闲超时：距上次收到数据超过该时长即切断（正常持续传输的长流不受影响） */
export const UPSTREAM_IDLE_TIMEOUT_MS = 120_000;

/** 请求体大小上限 */
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * 单请求 TPM 预估 token 数上界。
 * max_tokens 仅是输出上限，客户端可能传极大值（如 1000000），
 * 不钳制会一次烧尽整个 TPM 配额；8192 是高估但不离谱的单次输出预估值
 */
export const MAX_ESTIMATED_TOKENS = 8192;

/**
 * 可重试的上游错误状态码
 *
 * 429（限流）、401（密钥失效）、403（密钥无权限/被拦截）、402（欠费/额度耗尽，
 * recordKeyError 计数增量最大 +5 直接达自动禁用阈值）均表示当前 Key 或平台
 * 不可用，封禁当前 Key 并换 Key/换平台重试。5xx 等其它错误不重试，直接真实透传。
 */
export const RETRYABLE_UPSTREAM_STATUSES = new Set([429, 401, 403, 402]);

/**
 * 空响应哨兵：上游返回 2xx 但响应体为空（空 JSON / 空 SSE 流 / 空 multipart）。
 * 上游响应处理函数检测到后返回此哨兵，调用方将其判定为无效并纳入重试
 * （封禁当前 Key → 换 Key → 换平台），耗尽后返回 502 明确错误，绝不透传空响应。
 */
export const EMPTY_UPSTREAM_RESPONSE = Symbol("empty-upstream-response");

/**
 * 透传白名单禁止项（大小写不敏感）：认证/请求语义类头不得由下游客户端透传覆盖。
 *
 * authorization/x-api-key 承载平台密钥，若平台把同名头加入 forwardHeaders，
 * 展开顺序上透传值会覆盖代理注入的认证头——任意下游客户端可借此替换平台密钥
 * （401 封禁循环 / BYOK 绕过计费）；content-type 决定上游对请求体的解析语义、
 * host 决定虚拟主机路由，均须由本代理按平台配置生成。管理后台表单同样禁止
 * 把此类头名写入白名单（双端防护，代理层为最终防线）。下游伪造
 * x-forwarded-* / cf-connecting-ip 等可污染日志 IP 与上游侧来源判定。
 */
export const FORBIDDEN_FORWARD_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "cookie",
  "content-type",
  "content-length",
  "host",
  "connection",
  "transfer-encoding",
  "upgrade",
  "expect",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "cf-connecting-ip",
  "eo-client-ip",
  "eo-connecting-ip",
  "x-vercel-forwarded-for",
]);

/**
 * 从请求体预估 TPM 预扣 token 数（三端同源同算法）。
 *
 * max_tokens 仅是输出上限，客户端可能传极大值，钳制到 MAX_ESTIMATED_TOKENS；
 * Responses 使用 max_output_tokens，Chat 使用 max_tokens/max_completion_tokens，
 * 兼容三者。multipart（图片/音频）请求体无 token 字段且实际消耗达数千至数万
 * token，按上限预扣，防止 TPM 配额被以 1 token 的名义绕过。
 */
export function estimateRequestTokens(
  body: Record<string, unknown>,
  isMultipart: boolean
): number {
  if (isMultipart) return MAX_ESTIMATED_TOKENS;
  return Math.min(
    MAX_ESTIMATED_TOKENS,
    Math.max(1, Number((body as { max_output_tokens?: unknown }).max_output_tokens || body.max_tokens || body.max_completion_tokens) || 1)
  );
}

/**
 * 重试指数退避 + 抖动（防重试风暴）：同平台换 Key 后立即重打同一过载平台只会
 * 加剧 429（上游限流窗口未复位），等待 250ms×2^attempt（上限 2s）+ 0~250ms
 * 随机抖动错峰后再发下一轮；换平台路径不加（新平台可能不忙）
 */
export function retryBackoffMs(attempt: number): number {
  return Math.min(250 * Math.pow(2, attempt), 2000) + Math.random() * 250;
}

/**
 * 网络层失败是否为总超时中止（AbortError）：Worker 原生 fetch 抛 DOMException，
 * Node/undici 抛 Error——只判 DOMException 会漏判超时
 */
export function isAbortLikeError(err: unknown): boolean {
  return (
    (err instanceof DOMException || err instanceof Error) &&
    err.name === "AbortError"
  );
}
