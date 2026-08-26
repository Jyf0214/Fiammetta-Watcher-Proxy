/**
 * 上游错误脱敏核心（proxy-core 第四块）
 *
 * 三入口（worker/src/proxy.ts 全量版、worker/src/proxy-lite.ts lite 版、
 * pages/api/v1/[[...v1]].ts Pages 版）此前各自内联实现了同一段上游错误体
 * 解析与脱敏逻辑，三份实现逐字相同：
 * - extractUpstreamErrorMessage：从上游 JSON 错误体提取可读消息（兼容
 *   error.message / message / detail，FastAPI 数组 detail 逐条拼接，截断 500）；
 * - sanitizeMessage：403/401/429 返回通用文案防敏感策略泄露，其余保留原文；
 * - sanitizeUpstreamErrorBody：组装 { error: { message, type:"upstream_error",
 *   upstream_status } } 脱敏响应体。
 * 本模块把该语义固化为唯一实现，三端统一导入，消除副本漂移。
 */

/** 提取上游错误体中的可读消息 */
export function extractUpstreamErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text);
    // parsed?.detail 可能是数组（FastAPI 标准格式）或对象，不能直接 String()，否则变成 "[object Object]"
    const raw = parsed?.error?.message || parsed?.message || parsed?.detail || "";
    if (typeof raw === "string") return raw.substring(0, 500);
    if (Array.isArray(raw)) return raw.map((r: unknown) => {
      const s = (r as Record<string, unknown>)?.msg || (r as Record<string, unknown>)?.detail || String(r);
      return typeof s === "string" ? s : "";
    }).filter(Boolean).join("; ").substring(0, 500);
    return String(raw).substring(0, 500);
  } catch {
    return "上游服务返回未知错误";
  }
}

/**
 * 对上游原始错误消息进行脱敏，防止敏感信息（如地区封锁策略、内部地址等）泄露给客户端
 * 403/401/429 返回通用消息，其余错误保留原始消息（5xx 错误信息通常不敏感）
 */
export function sanitizeUpstreamMessage(original: string, status: number): string {
  if (status === 403) return "上游访问被拒绝（HTTP 403）";
  if (status === 401) return "上游认证失败（HTTP 401）";
  if (status === 429) return "上游请求过多（HTTP 429）";
  return original;
}

/**
 * 脱敏上游错误响应，仅提取错误消息
 */
export function sanitizeUpstreamError(errorText: string, upstreamStatus: number): string {
  return JSON.stringify({
    error: {
      message: sanitizeUpstreamMessage(extractUpstreamErrorMessage(errorText), upstreamStatus),
      type: "upstream_error",
      upstream_status: upstreamStatus,
    },
  });
}
