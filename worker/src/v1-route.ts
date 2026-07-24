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
    default:
      if (endpoint.startsWith("/models/")) {
        return { upstreamPath: endpoint, supportsStreaming: false };
      }
      return null;
  }
}

/**
 * 处理 /v1/* 路由请求
 */
export async function handleV1Route(
  request: Request,
  env: { DB: D1Database; KV: KVNamespace },
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  const endpointConfig = getEndpointConfig(url.pathname);
  if (!endpointConfig) {
    return Response.json(
      { error: { message: "不支持的 API 端点", type: "invalid_request_error" } },
      { status: 404 }
    );
  }

  // GET /v1/models — 返回模型列表
  if (url.pathname === "/v1/models" && request.method === "GET") {
    return handleModelsList(env.DB);
  }

  // GET /v1/models/:model — 返回单个模型信息
  if (url.pathname.startsWith("/v1/models/") && request.method === "GET") {
    const modelId = decodeURIComponent(url.pathname.slice("/v1/models/".length));
    return handleModelDetail(modelId, env.DB);
  }

  // 验证 API Key
  const authResult = await validateApiKey(
    request.headers.get("authorization"),
    env.DB
  );
  if ("error" in authResult) return authResult.error;

  // 代理转发
  return proxyV1Request(request, endpointConfig, authResult.apiKey, env, ctx);
}

/**
 * GET /v1/models — 返回所有可用模型列表
 */
async function handleModelsList(db: D1Database): Promise<Response> {
  await refreshCache(db);

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
  db: D1Database
): Promise<Response> {
  await refreshCache(db);

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
