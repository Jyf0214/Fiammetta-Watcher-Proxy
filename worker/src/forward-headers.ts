/**
 * 透传请求头处理
 *
 * 从下游请求中提取白名单内的请求头，透传给上游平台。
 * 仅提取平台配置中 forwardHeaders 白名单内指定的头。
 */

/**
 * 从下游请求头中提取可透传的请求头
 *
 * @param requestHeaders - 下游请求头
 * @param forwardHeadersConfig - 平台配置的透传头白名单（JSON 字符串数组）
 * @returns 可透传的请求头对象
 */
export function extractForwardableHeaders(
  requestHeaders: Headers,
  forwardHeadersConfig: string
): Record<string, string> {
  const result: Record<string, string> = {};

  if (!forwardHeadersConfig || forwardHeadersConfig === "[]") return result;

  let allowedHeaders: string[];
  try {
    allowedHeaders = JSON.parse(forwardHeadersConfig);
    if (!Array.isArray(allowedHeaders)) return result;
  } catch {
    return result;
  }

  for (const headerName of allowedHeaders) {
    if (typeof headerName !== "string") continue;
    const lowerName = headerName.toLowerCase();
    const value = requestHeaders.get(headerName) ?? requestHeaders.get(lowerName);
    if (value !== null) {
      result[headerName] = value;
    }
  }

  return result;
}
