/**
 * 代理请求公共处理逻辑
 *
 * 提取 chat/completions 和 completions 路由共享的：
 * - 上游错误脱敏
 * - 请求体解析与大小限制
 * - 简化版本，移除 Prisma 直接调用，使用 Drizzle ORM
 *
 * 注意：速率限制和流式响应处理在各路由文件中直接实现，
 * 此模块仅提供可复用的工具函数。
 */

// ==================== 上游错误脱敏 ====================

/**
 * 脱敏上游错误响应，仅提取错误消息，不透传完整响应体
 *
 * 防止上游 API 的内部信息（API Key、内部路径、堆栈等）泄露给客户端。
 *
 * @param errorText 上游错误响应体文本
 * @param upstreamStatus 上游 HTTP 状态码
 * @returns 脱敏后的 JSON 错误字符串
 */
export function sanitizeUpstreamError(
  errorText: string,
  upstreamStatus: number
): string {
  try {
    const parsed = JSON.parse(errorText);
    // 提取 OpenAI 兼容格式的 error.message
    const message =
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.detail ||
      "";
    return JSON.stringify({
      error: {
        message: String(message).substring(0, 500) || "上游服务返回错误",
        type: "upstream_error",
        upstream_status: upstreamStatus,
      },
    });
  } catch {
    // 非 JSON 响应，返回通用错误
    return JSON.stringify({
      error: {
        message: "上游服务返回未知错误",
        type: "upstream_error",
        upstream_status: upstreamStatus,
      },
    });
  }
}

// ==================== 请求体解析 ====================

/** 最大请求体大小：10 MB */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * 解析请求体 JSON，包含大小限制和 JSON 校验
 *
 * 使用 TextEncoder 获取实际字节数（替代 Buffer.byteLength），
 * 适配 Cloudflare Workers 运行时。
 *
 * @param bodyText 原始请求体文本
 * @returns body（解析后的 JSON）或 { error: Response }
 */
export function parseRequestBody<T>(
  bodyText: string
): { body: T } | { error: Response } {
  // 使用 TextEncoder 检查实际字节数，而非 string.length（后者仅统计 UTF-16 code unit，多字节字符会被低估）
  if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
    return {
      error: Response.json(
        { error: { message: "请求体过大", type: "invalid_request_error" } },
        { status: 413 }
      ),
    };
  }

  let body: T;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      error: Response.json(
        { error: { message: "请求体格式错误", type: "invalid_request_error" } },
        { status: 400 }
      ),
    };
  }

  return { body };
}

/**
 * 读取请求体文本（从 Hono Context）
 *
 * 封装 c.req.text() 的错误处理。
 */
export async function readBodyText(c: { req: { text: () => Promise<string> } }): Promise<
  { bodyText: string } | { error: Response }
> {
  let bodyText: string;
  try {
    bodyText = await c.req.text();
  } catch {
    return {
      error: Response.json(
        { error: { message: "读取请求体失败", type: "invalid_request_error" } },
        { status: 400 }
      ),
    };
  }
  return { bodyText };
}
