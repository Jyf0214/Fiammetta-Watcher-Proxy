/**
 * V1 路由分发器（lite 版）
 *
 * 处理 /v1/* 路径的请求分发（与全量版 v1-route.ts 语义一致）：
 * - 解析 URL 路径确定端点（复用 endpoints.ts 端点表）
 * - GET /v1/models → 模型列表
 * - POST /v1/* → API Key 验证 + 单次代理转发
 *
 * lite 构建不引入全量版 router/proxy（无评分/熔断/重试代码）。
 */

import { validateApiKey } from "./auth";
import { proxyV1RequestLite } from "./proxy-lite";
import { getEndpointConfig } from "./endpoints";
import {
  refreshCacheLite,
  getPlatformCacheLite,
  getPlatformModelCacheLite,
} from "./router-lite";
import { formatAnthropicError, estimateInputTokens } from "@/lib/anthropic";
import type { WorkerEnv } from "./config";

/** 请求体大小上限（与 proxy-lite.ts 保持一致） */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * 提取 API Key：兼容 Anthropic 客户端（x-api-key 头）与 OpenAI 客户端（Authorization: Bearer）
 */
function getApiKeyHeader(request: Request): string | null {
  // authorization 优先（OpenAI 惯例），回退 x-api-key（Anthropic 惯例）——与全量版一致
  return request.headers.get("authorization") || request.headers.get("x-api-key");
}

/**
 * 将认证失败响应转为 Anthropic 协议错误格式（{type:"error",error:{type,message}}）
 */
async function anthropicAuthErrorResponse(authError: Response): Promise<Response> {
  const errBody = (await authError.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  return Response.json(
    formatAnthropicError(authError.status, errBody?.error?.message || "认证失败"),
    { status: authError.status }
  );
}

/**
 * 处理 /v1/* 路由请求（lite）
 */
export async function handleV1RouteLite(
  request: Request,
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // POST /v1/messages/count_tokens — token 估算（不转发上游）
  if (url.pathname === "/v1/messages/count_tokens" && request.method === "POST") {
    const authResult = await validateApiKey(getApiKeyHeader(request), env.DB, env);
    if ("error" in authResult) {
      return anthropicAuthErrorResponse(authResult.error);
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

  // 验证 API Key（models 端点同样需要认证，防止匿名枚举模型/平台名）
  const authResult = await validateApiKey(getApiKeyHeader(request), env.DB, env);
  if ("error" in authResult) {
    // Anthropic 协议分支用 Anthropic 错误格式（{type:"error",error:{type,message}}）
    if (endpointConfig.protocol === "anthropic") {
      return anthropicAuthErrorResponse(authResult.error);
    }
    return authResult.error;
  }

  // GET /v1/models — 返回模型列表
  if (url.pathname === "/v1/models" && request.method === "GET") {
    return handleModelsListLite(env.DB, env);
  }

  // GET /v1/models/:model — 返回单个模型信息
  if (url.pathname.startsWith("/v1/models/") && request.method === "GET") {
    const modelId = decodeURIComponent(url.pathname.slice("/v1/models/".length));
    return handleModelDetailLite(modelId, env.DB, env);
  }

  // 代理转发（单次尝试）
  return proxyV1RequestLite(request, endpointConfig, authResult.apiKey, env, ctx);
}

/**
 * GET /v1/models — 返回所有可用模型列表
 */
async function handleModelsListLite(db: D1Database, env?: WorkerEnv): Promise<Response> {
  await refreshCacheLite(db, env);

  const models: Array<{ id: string; object: string; owned_by: string }> = [];
  const platformCache = getPlatformCacheLite();
  const platformModelCache = getPlatformModelCacheLite();

  // 同名模型多平台重复：按平台优先级（priority 小者优先）取最优归属去重
  // （与 v1-route.ts / Pages 版同构）
  const seen = new Set<string>();
  const orderedPids = [...platformModelCache.keys()].sort((a, b) => {
    const pa = platformCache.find((p) => p.id === a)?.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = platformCache.find((p) => p.id === b)?.priority ?? Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });

  for (const platformId of orderedPids) {
    const platform = platformCache.find((p) => p.id === platformId);
    const ownedBy = platform?.name ?? "unknown";

    for (const modelId of platformModelCache.get(platformId) ?? []) {
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      models.push({ id: modelId, object: "model", owned_by: ownedBy });
    }
  }

  return Response.json({ object: "list", data: models });
}

/**
 * GET /v1/models/:model — 返回单个模型信息
 */
async function handleModelDetailLite(
  modelId: string,
  db: D1Database,
  env?: WorkerEnv
): Promise<Response> {
  await refreshCacheLite(db, env);

  const platformCache = getPlatformCacheLite();
  const platformModelCache = getPlatformModelCacheLite();

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
