/**
 * 透传请求头处理
 *
 * 从下游请求中提取白名单内的请求头，透传给上游平台。
 * 仅提取平台配置中 forwardHeaders 白名单内指定的头。
 * 对头值做 CR/LF/NUL 净化，防止 HTTP 头注入。
 */

/**
 * 净化 HTTP 头值，移除 CR (\r)、LF (\n)、NUL (\0) 字符
 *
 * 这些字符可能被用于 HTTP 头注入攻击，必须在透传前清除。
 */
function sanitizeHeaderValue(value: string): string {
  // 移除 CR (0x0D)、LF (0x0A)、NUL (0x00) 字符，防止 HTTP 头注入
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code !== 0x0d && code !== 0x0a && code !== 0x00) {
      result += value[i];
    }
  }
  return result;
}

/**
 * 验证 HTTP 头名称是否合法
 *
 * HTTP 头名称只能包含可打印 ASCII 字符，不能包含空格、冒号等特殊字符。
 * @param name - 要验证的头名称
 * @returns 是否合法
 */
function isValidHeaderName(name: string): boolean {
  if (!name || name.length === 0) return false;
  // HTTP 头名称只允许可打印 ASCII 字符（0x21-0x7E），不允许空格(0x20)、控制字符等
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  // 不能包含冒号（头名称:头值的分隔符）
  if (name.includes(":")) return false;
  return true;
}

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
    if (typeof headerName !== "string" || !isValidHeaderName(headerName)) continue;
    const lowerName = headerName.toLowerCase();
    const value = requestHeaders.get(headerName) ?? requestHeaders.get(lowerName);
    if (value !== null) {
      result[headerName] = sanitizeHeaderValue(value);
    }
  }

  return result;
}
