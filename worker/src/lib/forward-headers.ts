/**
 * 请求头白名单透传工具
 *
 * 从下游请求中提取平台配置的白名单请求头，用于透传给上游 API。
 * 仅传递平台明确配置的头部，防止敏感信息（如 Cookie、Authorization）泄露。
 */

/**
 * 从下游请求中提取平台配置的白名单请求头，返回可合并到上游请求头中的键值对。
 *
 * @param request 下游请求对象（Request）
 * @param forwardHeadersJson 平台的 forwardHeaders JSON 字符串（如 '["x-thinking-mode"]'）
 * @returns 允许透传的请求头键值对（键为原始大小写）
 */
export function extractForwardableHeaders(
  request: Request,
  forwardHeadersJson: string
): Record<string, string> {
  let allowedHeaders: string[];
  try {
    const parsed = JSON.parse(forwardHeadersJson);
    if (!Array.isArray(parsed)) return {};
    // 统一转为小写用于匹配
    allowedHeaders = parsed
      .filter((h): h is string => typeof h === "string" && h.length > 0)
      .map((h) => h.toLowerCase());
  } catch {
    return {};
  }

  if (allowedHeaders.length === 0) return {};

  const allowedSet = new Set(allowedHeaders);
  const result: Record<string, string> = {};

  for (const [key, value] of request.headers.entries()) {
    if (allowedSet.has(key.toLowerCase()) && value) {
      // 保留原始大小写，确保上游能正确识别
      result[key] = value;
    }
  }

  return result;
}
