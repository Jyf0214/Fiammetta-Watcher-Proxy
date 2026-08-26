/**
 * V1 路由分发核心（proxy-core 第九块）
 *
 * worker/src/v1-route.ts 全量版与 worker/src/v1-route-lite.ts lite 版此前是
 * 两份逐字相同的分发骨架（仅 proxy 处理器与路由缓存函数不同）；Pages 版
 * pages/api/v1/[[...v1]].ts 又内联了第三份端点表与模型列表/详情实现。
 * 本模块把以下语义固化为唯一实现，proxy/缓存以依赖注入方式接入
 * （lite 构建靠入口 tree-shaking，骨架不得静态引入全量链）：
 * - API Key 提取（authorization 优先，回退 x-api-key）；
 * - POST /v1/messages/count_tokens 分支（认证 → 413 预检 → JSON 解析 → 估算）；
 * - 端点表查询 + 404；
 * - API Key 验证（Anthropic 协议分支用 Anthropic 错误格式）；
 * - GET /v1/models 与 /v1/models/:model（模型列表去重与详情归属统一按平台
 *   优先级取最优——此前 Worker 两版详情按缓存插入序首个命中，与 Pages 版
 *   已修复的优先级归属漂移）。
 */

import { validateApiKey, type ApiKeyRecord } from "../auth";
import { getEndpointConfig, type ProxyConfig } from "../endpoints";
import { formatAnthropicError, estimateInputTokens } from "@/lib/anthropic";
import type { PlatformConfig } from "@/lib/types";
import type { WorkerEnv } from "../config";
import { MAX_BODY_BYTES } from "./proxy-constants";

// 兼容旧导入路径（测试与外部模块从 ./v1-route 引用端点配置）
export { getEndpointConfig, type ProxyConfig };

/** handleV1RouteCore 的依赖注入集 */
export interface V1RouteDeps {
  /** 代理处理器（全量版 proxyV1Request / lite 版 proxyV1RequestLite） */
  proxyHandler: (
    request: Request,
    config: ProxyConfig,
    apiKey: ApiKeyRecord,
    env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
    ctx: ExecutionContext
  ) => Promise<Response>;
  /** 路由缓存刷新（全量版 refreshCache / lite 版 refreshCacheLite） */
  refreshCache: (db: D1Database, env?: WorkerEnv) => Promise<void>;
  /** 平台缓存读取（全量版 getPlatformCache / lite 版 getPlatformCacheLite） */
  getPlatformCache: () => PlatformConfig[];
  /** 平台模型缓存读取 */
  getPlatformModelCache: () => Map<string, Set<string>>;
}

/**
 * 提取 API Key：兼容 Anthropic 客户端（x-api-key 头）与 OpenAI 客户端（Authorization: Bearer）
 */
export function getWorkerApiKeyHeader(request: Request): string | null {
  // authorization 优先（OpenAI 惯例），回退 x-api-key（Anthropic 惯例）——与 Pages 入口一致
  return request.headers.get("authorization") || request.headers.get("x-api-key");
}

/**
 * 将认证失败响应转为 Anthropic 协议错误格式（{type:"error",error:{type,message}}）
 */
export async function authErrorToAnthropicResponse(authError: Response): Promise<Response> {
  const errBody = (await authError.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  return Response.json(
    formatAnthropicError(authError.status, errBody?.error?.message || "认证失败"),
    { status: authError.status }
  );
}

/**
 * POST /v1/messages/count_tokens — token 估算（不转发上游）
 */
async function handleCountTokens(
  request: Request,
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv
): Promise<Response> {
  const authResult = await validateApiKey(getWorkerApiKeyHeader(request), env.DB, env);
  if ("error" in authResult) {
    return authErrorToAnthropicResponse(authResult.error);
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

/**
 * 构造 /v1/models 列表负载：同名模型多平台重复时按平台优先级（priority 小者
 * 优先）取最优归属去重，避免客户端模型下拉出现大量同名条目。
 * 三端（全量/lite/Pages）共用同一排序实体，杜绝两端口径漂移。
 */
export function buildModelsListPayload(
  platformCache: PlatformConfig[],
  platformModelCache: Map<string, Set<string>>
): Array<{ id: string; object: string; owned_by: string }> {
  const models: Array<{ id: string; object: string; owned_by: string }> = [];
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
  return models;
}

/**
 * 解析 /v1/models/:model 详情归属：与列表端点同一口径——按平台优先级
 * （priority 小者优先，缺失排最后）取最优归属平台名；无任何平台支持返回 null。
 * 此前 Worker 两版按缓存插入序首个命中，与 Pages 版已修复的优先级口径漂移，
 * 同一模型可能在列表与详情两处显示不同的 owned_by。
 */
export function resolveModelDetailOwner(
  platformCache: PlatformConfig[],
  platformModelCache: Map<string, Set<string>>,
  modelId: string
): string | null {
  const owningPids = [...platformModelCache.entries()]
    .filter(([, ms]) => ms.has(modelId))
    .map(([pid]) => pid)
    .sort((a, b) => {
      const pa = platformCache.find((p) => p.id === a)?.priority ?? Number.MAX_SAFE_INTEGER;
      const pb = platformCache.find((p) => p.id === b)?.priority ?? Number.MAX_SAFE_INTEGER;
      return pa - pb;
    });
  if (owningPids.length === 0) return null;
  const platform = platformCache.find((p) => p.id === owningPids[0]);
  return platform?.name ?? "unknown";
}

/** GET /v1/models — 返回所有可用模型列表 */
async function handleModelsList(
  db: D1Database,
  env: WorkerEnv | undefined,
  deps: V1RouteDeps
): Promise<Response> {
  await deps.refreshCache(db, env);
  return Response.json({
    object: "list",
    data: buildModelsListPayload(deps.getPlatformCache(), deps.getPlatformModelCache()),
  });
}

/** GET /v1/models/:model — 返回单个模型信息 */
async function handleModelDetail(
  modelId: string,
  db: D1Database,
  env: WorkerEnv | undefined,
  deps: V1RouteDeps
): Promise<Response> {
  await deps.refreshCache(db, env);
  const ownedBy = resolveModelDetailOwner(deps.getPlatformCache(), deps.getPlatformModelCache(), modelId);
  if (ownedBy !== null) {
    return Response.json({ id: modelId, object: "model", owned_by: ownedBy });
  }
  return Response.json(
    { error: { message: `模型 ${modelId} 不存在`, type: "invalid_request_error" } },
    { status: 404 }
  );
}

/**
 * 处理 /v1/* 路由请求（全量版与 lite 版共用骨架）
 */
export async function handleV1RouteCore(
  request: Request,
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext,
  deps: V1RouteDeps
): Promise<Response> {
  const url = new URL(request.url);

  // POST /v1/messages/count_tokens — token 估算（不转发上游）
  if (url.pathname === "/v1/messages/count_tokens" && request.method === "POST") {
    return handleCountTokens(request, env);
  }

  const endpointConfig = getEndpointConfig(url.pathname);
  if (!endpointConfig) {
    return Response.json(
      { error: { message: "不支持的 API 端点", type: "invalid_request_error" } },
      { status: 404 }
    );
  }

  // 验证 API Key（models 端点同样需要认证，防止匿名枚举模型/平台名——
  // 与 Pages 入口一致，认证通过后才处理 /v1/models 与 /v1/models/:model）
  const authResult = await validateApiKey(getWorkerApiKeyHeader(request), env.DB, env);
  if ("error" in authResult) {
    // Anthropic 协议分支用 Anthropic 错误格式（{type:"error",error:{type,message}}）
    if (endpointConfig.protocol === "anthropic") {
      return authErrorToAnthropicResponse(authResult.error);
    }
    return authResult.error;
  }

  // GET /v1/models — 返回模型列表
  if (url.pathname === "/v1/models" && request.method === "GET") {
    return handleModelsList(env.DB, env, deps);
  }

  // GET /v1/models/:model — 返回单个模型信息
  if (url.pathname.startsWith("/v1/models/") && request.method === "GET") {
    const modelId = decodeURIComponent(url.pathname.slice("/v1/models/".length));
    return handleModelDetail(modelId, env.DB, env, deps);
  }

  // 代理转发
  return deps.proxyHandler(request, endpointConfig, authResult.apiKey, env, ctx);
}
