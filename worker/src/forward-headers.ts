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
 * 验证 HTTP 头名称是否合法（RFC 7230 token 字符）
 *
 * HTTP 头名称只允许: 字母、数字、以及 !#$%&'*+-.^_`|~ 这些符号。
 * 空格、冒号、括号、斜杠等均不合法。
 * @param name - 要验证的头名称
 * @returns 是否合法
 */
function isValidHeaderName(name: string): boolean {
  if (!name || name.length === 0) return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    // ALPHA: A-Z (0x41-0x5A) 或 a-z (0x61-0x7A)
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) continue;
    // DIGIT: 0-9 (0x30-0x39)
    if (c >= 0x30 && c <= 0x39) continue;
    // tchar: ! # $ % & ' * + - . ^ _ ` | ~
    if ("!#$%&'*+-.^_`|~".charCodeAt(0) <= c) {
      const tchars = "!#$%&'*+-.^_`|~";
      if (tchars.includes(name[i])) continue;
    }
    return false;
  }
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
    try {
      const lowerName = headerName.toLowerCase();
      const value = requestHeaders.get(headerName) ?? requestHeaders.get(lowerName);
      if (value !== null) {
        result[headerName] = sanitizeHeaderValue(value);
      }
    } catch {
      // Workers 对某些 header 名会抛 TypeError，静默跳过
    }
  }

  return result;
}
