/**
 * Anthropic 错误响应格式化
 *
 * 格式：{ type: "error", error: { type, message } }
 * 供 /v1/messages 路径在本地校验失败、上游失败时使用；
 * OpenAI 客户端路径仍保持 OpenAI 错误格式，互不影响。
 */

/** OpenAI 错误类型 → Anthropic 错误类型映射 */
export function toAnthropicErrorType(status: number, openaiType?: string): string {
  switch (status) {
    case 400:
      return "invalid_request_error";
    case 401:
      return "authentication_error";
    case 403:
      return "permission_error";
    case 404:
      return "not_found_error";
    case 429:
      return "rate_limit_error";
    case 500:
    case 502:
    case 503:
      return "api_error";
    case 504:
      return "timeout_error";
    case 529:
      return "overloaded_error";
    default:
      return openaiType && openaiType.length > 0 ? openaiType : "api_error";
  }
}

/** 构造 Anthropic 错误响应体 */
export function formatAnthropicError(status: number, message: string, openaiType?: string): {
  type: "error";
  error: { type: string; message: string };
} {
  return {
    type: "error",
    error: {
      type: toAnthropicErrorType(status, openaiType),
      message,
    },
  };
}
