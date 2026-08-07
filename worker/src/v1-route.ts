/**
 * V1 路由分发器
 *
 * 处理 /v1/* 路径的请求分发：
 * - 解析 URL 路径确定端点
 * - GET /v1/models → 模型列表
 * - POST /v1/* → API Key 验证 + 代理转发
 *
 * 作为 router 和 proxy 之间的桥梁，避免循环依赖
 */

import { validateApiKey } from "./auth";
import { proxyV1Request, type ProxyConfig } from "./proxy";
import { refreshCache, getPlatformCache, getPlatformModelCache } from "./router";
import { convertAnthropicRequest, estimateInputTokens, formatAnthropicError } from "@/lib/anthropic";
import type { WorkerEnv } from "./config";

/** 请求体大小上限（与 proxy.ts 的 parseRequestBody 保持一致） */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * 根据路径确定端点配置
 */
function getEndpointConfig(pathname: string): ProxyConfig | null {
  const endpoint = pathname.replace(/^\/v1/, "");

  switch (endpoint) {
    case "/chat/completions":
      return { upstreamPath: "/chat/completions", supportsStreaming: true };
    case "/completions":
      return { upstreamPath: "/completions", supportsStreaming: true };
    case "/embeddings":
      return { upstreamPath: "/embeddings", supportsStreaming: false };
    case "/images/generations":
      return { upstreamPath: "/images/generations", supportsStreaming: false };
    case "/images/edits":
      return { upstreamPath: "/images/edits", supportsStreaming: false };
    case "/images/variations":
      return { upstreamPath: "/images/variations", supportsStreaming: false };
    case "/audio/speech":
      return { upstreamPath: "/audio/speech", supportsStreaming: false };
    case "/audio/transcriptions":
      return { upstreamPath: "/audio/transcriptions", supportsStreaming: false };
    case "/audio/translations":
      return { upstreamPath: "/audio/translations", supportsStreaming: false };
    case "/responses":
      return { upstreamPath: "/responses", supportsStreaming: true };
    case "/models":
      return { upstreamPath: "/models", supportsStreaming: false };
    case "/messages":
      return {
        upstreamPath: "/chat/completions",
        supportsStreaming: true,
        protocol: "anthropic",
        buildUpstreamBody: convertAnthropicRequest,
      };
    default:
      if (endpoint.startsWith("/models/")) {
        return { upstreamPath: endpoint, supportsStreaming: false };
      }
      return null;
  }
}

/**
 * 提取 API Key：兼容 Anthropic 客户端（x-api-key 头）与 OpenAI 客户端（Authorization: Bearer）
 */
function getApiKeyHeader(request: Request): string | null {
  // authorization 优先（OpenAI 惯例），回退 x-api-key（Anthropic 惯例）——与 Pages 入口一致
  return request.headers.get("authorization") || request.headers.get("x-api-key");
}

/**
 * 处理 /v1/* 路由请求
 */
export async function handleV1Route(
  request: Request,
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // POST /v1/messages/count_tokens — token 估算（不转发上游）
  if (url.pathname === "/v1/messages/count_tokens" && request.method === "POST") {
    const authResult = await validateApiKey(getApiKeyHeader(request), env.DB, env);
    if ("error" in authResult) {
      const errBody = await authResult.error.json().catch(() => ({})) as { error?: { message?: string } };
      return Response.json(formatAnthropicError(authResult.error.status, errBody?.error?.message || "认证失败"), { status: authResult.error.status });
    }
    let body: Record<string, unknown>;
    // 与主路径一致：超大请求体（Content-Length 预检）直接拒绝，避免整体读入内存
    if (Number(request.headers.get("content-length") || "0") > MAX_BODY_BYTES) {
      return Response.json(formatAnthropicError(413, "请求体过大"), { status: 413 });
    }
    try {
      body = await request.json() as Record<string, unknown>;
    } catch {
      return Response.json(formatAnthropicError(400, "请求体格式错误"), { status: 400 });
    }
    return Response.json({ input_tokens: estimateInputTokens(body) });
  }

  const endpointConfig = getEndpointConfig(url.pathname);
  if (!endpointConfig) {
    return Response.json(
      { error: { message: "不支持的 API 端点", type: "invalid_request_error" } },
      { status: 404 }
    );
  }

  // GET /v1/models — 返回模型列表
  if (url.pathname === "/v1/models" && request.method === "GET") {
    return handleModelsList(env.DB, env);
  }

  // GET /v1/models/:model — 返回单个模型信息
  if (url.pathname.startsWith("/v1/models/") && request.method === "GET") {
    const modelId = decodeURIComponent(url.pathname.slice("/v1/models/".length));
    return handleModelDetail(modelId, env.DB, env);
  }

  // 验证 API Key
  const authResult = await validateApiKey(getApiKeyHeader(request), env.DB, env);
  if ("error" in authResult) {
    // Anthropic 协议分支用 Anthropic 错误格式（{type:"error",error:{type,message}}）
    if (endpointConfig.protocol === "anthropic") {
      const errBody = await authResult.error.json().catch(() => ({})) as { error?: { message?: string } };
      return Response.json(formatAnthropicError(authResult.error.status, errBody?.error?.message || "认证失败"), { status: authResult.error.status });
    }
    return authResult.error;
  }

  // 代理转发
  return proxyV1Request(request, endpointConfig, authResult.apiKey, env, ctx);
}

/**
 * GET /v1/models — 返回所有可用模型列表
 */
async function handleModelsList(db: D1Database, env?: WorkerEnv): Promise<Response> {
  await refreshCache(db, env);

  const models: Array<{ id: string; object: string; owned_by: string }> = [];
  const platformCache = getPlatformCache();
  const platformModelCache = getPlatformModelCache();

  for (const [platformId, modelSet] of platformModelCache) {
    const platform = platformCache.find((p) => p.id === platformId);
    const ownedBy = platform?.name ?? "unknown";

    for (const modelId of modelSet) {
      models.push({ id: modelId, object: "model", owned_by: ownedBy });
    }
  }

  return Response.json({ object: "list", data: models });
}

/**
 * GET /v1/models/:model — 返回单个模型信息
 */
async function handleModelDetail(
  modelId: string,
  db: D1Database,
  env?: WorkerEnv
): Promise<Response> {
  await refreshCache(db, env);

  const platformCache = getPlatformCache();
  const platformModelCache = getPlatformModelCache();

  for (const [platformId, modelSet] of platformModelCache) {
    if (modelSet.has(modelId)) {
      const platform = platformCache.find((p) => p.id === platformId);
      return Response.json({
        id: modelId,
        object: "model",
        owned_by: platform?.name ?? "unknown",
      });
    }
  }

  return Response.json(
    { error: { message: `模型 ${modelId} 不存在`, type: "invalid_request_error" } },
    { status: 404 }
  );
}
