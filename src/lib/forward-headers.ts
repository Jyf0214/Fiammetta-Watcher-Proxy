/**
 * 请求头白名单透传工具
 *
 * 从下游请求中提取白名单内的请求头，用于透传给上游 API。
 * 仅传递明确列出的头部，防止敏感信息（如 Cookie、Authorization）泄露。
 */

/** 允许透传给上游的请求头名称（小写） */
const FORWARDABLE_HEADER_SET = new Set([
  // 思考 / 推理模式
  "x-thinking-mode",
  "x-reasoning-effort",

  // 通用元信息（部分上游端点需要）
  "accept-language",
  "x-request-id",
]);

/**
 * 从下游请求中提取白名单请求头，返回可合并到上游请求头中的键值对。
 *
 * @param request 下游请求对象（NextRequest / Request）
 * @returns 允许透传的请求头键值对（键为原始大小写）
 */
export function extractForwardableHeaders(
  request: Request
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of request.headers.entries()) {
    if (FORWARDABLE_HEADER_SET.has(key.toLowerCase()) && value) {
      // 保留原始大小写，确保上游能正确识别
      result[key] = value;
    }
  }

  return result;
}
