/**
 * /v1/* 代理路由 — Pages API 版本
 *
 * 非 Cloudflare 部署时由 Pages API 处理 /v1/* 代理请求。
 * Cloudflare 部署时此文件被构建门控脚本临时移除，由 Worker 处理。
 *
 * 核心逻辑复用 worker/src/ 下的业务模块，仅适配 Pages 运行时环境。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { validateApiKey, type ApiKeyRecord } from "../../../worker/src/auth";
import { routeRequest, refreshCache, getPlatformCache, getPlatformModelCache, freezeAutoModel, isAutoModelRequest, getPlatformsForModel } from "../../../worker/src/router";
import { getNextKey, getRandomKeyExcept, banKey, recordKeyError, loadWhitelist, loadKeyStatusFromKV } from "../../../worker/src/platform-keys";
import { recordSuccess, recordFailure, selectPlatform, releaseHalfOpenPending } from "../../../worker/src/load-balancer";
import { extractUsage, updateKeyUsage, recordRequestLog } from "../../../worker/src/token";
import { extractForwardableHeaders, parseExtraHeaders } from "../../../worker/src/forward-headers";
import { loadTemplates, getApplicableTemplates, applyTemplates } from "../../../worker/src/request-templates";
import { checkPlatformRpm, checkPlatformTpm, checkApiKeyRpm, checkApiKeyTpm } from "@/lib/v1-rate-limit";
import { getUpstreamProxy, markProxyFailure, recordProxyTraffic } from "@/lib/upstream-proxy";
import { isSafeUpstreamUrl } from "@/lib/ssrf";
import { convertAnthropicRequest, convertOpenAIResponse, OpenAIToAnthropicStream, estimateInputTokens, formatAnthropicError, AnthropicRequestError, convertOpenAIRequest, OpenAIRequestError, convertAnthropicResponse, AnthropicToOpenAIStream } from "@/lib/anthropic";
import type { WorkerEnv } from "../../../worker/src/config";

/**
 * 禁用默认 bodyParser：本路由需读取原始请求体文本（与 Worker 版一致），
 * 否则 Next.js 会先消费 JSON 流，parseRequestBody 读到空串导致 400。
 */
export const config = {
  api: {
    bodyParser: false,
  },
};

interface ProxyConfig {
  upstreamPath: string;
  supportsStreaming?: boolean;
  /** 代理协议：anthropic 时做 /v1/messages ↔ /chat/completions 双向转换 */
  protocol?: "openai" | "anthropic";
  /** 上游请求体构造钩子（Anthropic 分支用，把下游格式转为 OpenAI 格式） */
  buildUpstreamBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * 单请求 TPM 预估 token 数上界。
 * max_tokens 仅是输出上限，客户端可能传极大值（如 1000000），
 * 不钳制会一次烧尽整个 TPM 配额；8192 是高估但不离谱的单次输出预估值
 */
const MAX_ESTIMATED_TOKENS = 8192;

/**
 * 透传白名单禁止项（大小写不敏感）：认证/请求语义类头不得由下游客户端透传覆盖。
 *
 * authorization/x-api-key 承载平台密钥，若平台把同名头加入 forwardHeaders，
 * 展开顺序上透传值会覆盖代理注入的认证头——任意下游客户端可借此替换平台密钥
 * （401 封禁循环 / BYOK 绕过计费）；content-type 决定上游对请求体的解析语义、
 * host 决定虚拟主机路由，均须由本代理按平台配置生成。管理后台表单同样禁止
 * 把此类头名写入白名单（双端防护，代理层为最终防线）。
 */
const FORBIDDEN_FORWARD_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "cookie",
  "content-type",
  "content-length",
  "host",
  "connection",
  "transfer-encoding",
  "upgrade",
  "expect",
]);

/** 提取上游错误体中的可读消息 */
function extractUpstreamErrorMessage(text: string): string {
  try {
    const p = JSON.parse(text);
    // p?.detail 可能是数组（FastAPI 标准格式）或对象，不能直接 String()，否则变成 "[object Object]"
    const raw = p?.error?.message || p?.message || p?.detail || "";
    if (typeof raw === "string") return raw.substring(0, 500);
    if (Array.isArray(raw)) return raw.map((r: unknown) => {
      const s = (r as Record<string, unknown>)?.msg || (r as Record<string, unknown>)?.detail || String(r);
      return typeof s === "string" ? s : "";
    }).filter(Boolean).join("; ").substring(0, 500);
    return String(raw).substring(0, 500);
  } catch {
    return "上游服务返回未知错误";
  }
}

function sanitizeUpstreamError(text: string, status: number): string {
  return JSON.stringify({ error: { message: extractUpstreamErrorMessage(text), type: "upstream_error", upstream_status: status } });
}

/**
 * 按协议发送错误响应：anthropic 用 {type:"error",error:{type,message}}，
 * openai 保持 {error:{message,type,...}}。状态码两边保持一致。
 */
function sendV1Error(
  res: NextApiResponse,
  cfg: ProxyConfig,
  status: number,
  message: string,
  type: string,
  extra?: Record<string, unknown>
): void {
  if (cfg.protocol === "anthropic") {
    res.status(status).json(formatAnthropicError(status, message, type));
    return;
  }
  res.status(status).json({ error: { message, type, ...extra } });
}

/**
 * 解析 Pages 运行时环境变量（含 DATABASE_URL 等 Secret）
 *
 * 之前只传 { DB_TYPE: process.env.DB_TYPE }，数据库连接 URL 永远不会进入
 * lib/prisma.ts 的解析链，导致 Pages 侧 v1 代理被推断为 d1 并连接错误的库。
 * 改为从 Cloudflare Context 取完整 env，并同步到 process.env（与 Worker 入口一致）。
 */
let pagesEnvPromise: Promise<WorkerEnv & { KV?: KVNamespace; DB?: D1Database }> | null = null;

async function resolvePagesEnv(): Promise<WorkerEnv & { KV?: KVNamespace; DB?: D1Database }> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = getCloudflareContext() as { env: Record<string, any> };
    if (env.DB_TYPE) process.env.DB_TYPE = env.DB_TYPE;
    if (env.DATABASE_URL) process.env.DATABASE_URL = env.DATABASE_URL;
    if (env.TIDB_URL) process.env.TIDB_URL = env.TIDB_URL;
    if (env.PG_URL) process.env.PG_URL = env.PG_URL;
    if (env.MARIADB_URL) process.env.MARIADB_URL = env.MARIADB_URL;
    if (env.MYSQL_URL) process.env.MYSQL_URL = env.MYSQL_URL;
    return {
      DB_TYPE: env.DB_TYPE,
      DATABASE_URL: env.DATABASE_URL,
      TIDB_URL: env.TIDB_URL,
      PG_URL: env.PG_URL,
      MARIADB_URL: env.MARIADB_URL,
      MYSQL_URL: env.MYSQL_URL,
      KV: env.KV,
      // D1 binding 必须透传：v1 路由的 createDb 依赖 env.DB 构造 PrismaD1，
      // 缺失时 D1 部署下所有统计/熔断/错误计数写入静默失败
      DB: env.DB,
    };
  } catch {
    // 本地开发或非 Cloudflare 环境：回退 process.env
    return {
      DB_TYPE: process.env.DB_TYPE,
      DATABASE_URL: process.env.DATABASE_URL,
      TIDB_URL: process.env.TIDB_URL,
      PG_URL: process.env.PG_URL,
      MARIADB_URL: process.env.MARIADB_URL,
      MYSQL_URL: process.env.MYSQL_URL,
    };
  }
}

function createPagesEnv(): Promise<WorkerEnv & { KV?: KVNamespace; DB?: D1Database }> {
  if (!pagesEnvPromise) pagesEnvPromise = resolvePagesEnv();
  return pagesEnvPromise;
}
// Pages 环境下无独立 D1 binding 变量，业务模块统一接收 { DB } 参数；
// 首次请求时把真实 binding 同步进来，避免 D1 部署下 createDb 构造 PrismaD1 失败
let dummyDb: D1Database = {} as D1Database;
let dbBound = false;
/** 首次绑定闩锁：并发请求共享同一次绑定，避免 dbBound 提前置位后并发请求用空 DB */
let dbBindPromise: Promise<void> | null = null;

/** 白名单是否已加载（Pages 进程内懒加载，首次请求触发，后续请求跳过） */
let whitelistLoaded = false;
/** Key 持久化状态是否已加载（同 whitelistLoaded 模式） */
let keyStatusLoaded = false;

// ==================== 上游超时与重试配置 ====================

/** 上游请求总超时（等待响应头 + 非流式响应体） */
const UPSTREAM_TIMEOUT_MS = 120_000;

/** 流式响应空闲超时：距上次收到数据超过该时长即切断（正常持续传输的长流不受影响） */
const UPSTREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * 可重试的上游错误状态码
 *
 * 429（限流）、401（密钥失效）、403（密钥无权限/被拦截）均表示当前 Key 或平台
 * 不可用，封禁当前 Key 并换 Key/换平台重试。5xx 等其它错误不重试，直接真实透传。
 */
const RETRYABLE_UPSTREAM_STATUSES = new Set([429, 401, 403, 402]);

/**
 * 空响应哨兵：上游返回 2xx 但响应体为空（空 JSON / 空 SSE 流 / 空 multipart）。
 * handleUpstreamResponsePages 检测到后返回此哨兵，调用方将其判定为无效并纳入重试
 * （封禁当前 Key → 换 Key → 换平台），耗尽后返回 502 明确错误，绝不透传空响应。
 */
const EMPTY_UPSTREAM_RESPONSE = Symbol("empty-upstream-response");

const MAX_BODY_BYTES = 10 * 1024 * 1024;
async function parseRequestBody<T>(req: NextApiRequest): Promise<{ body: T } | { error: string }> {
  const cl = Number(req.headers["content-length"] || "0");
  if (cl > MAX_BODY_BYTES) return { error: "请求体过大" };
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf-8");
  if (text.length > MAX_BODY_BYTES) return { error: "请求体过大" };
  try { return { body: JSON.parse(text) as T }; } catch { return { error: "请求体格式错误" }; }
}

function getEndpointConfig(pathname: string): ProxyConfig | null {
  const ep = pathname.replace(/^\/v1/, "");
  const map: Record<string, ProxyConfig> = {
    "/chat/completions": { upstreamPath: "/chat/completions", supportsStreaming: true },
    "/completions": { upstreamPath: "/completions", supportsStreaming: true },
    "/embeddings": { upstreamPath: "/embeddings" },
    "/images/generations": { upstreamPath: "/images/generations" },
    "/images/edits": { upstreamPath: "/images/edits" },
    "/images/variations": { upstreamPath: "/images/variations" },
    "/audio/speech": { upstreamPath: "/audio/speech" },
    "/audio/transcriptions": { upstreamPath: "/audio/transcriptions" },
    "/audio/translations": { upstreamPath: "/audio/translations" },
    "/responses": { upstreamPath: "/responses", supportsStreaming: true },
    "/models": { upstreamPath: "/models" },
    "/messages": {
      upstreamPath: "/chat/completions",
      supportsStreaming: true,
      protocol: "anthropic",
      buildUpstreamBody: convertAnthropicRequest,
    },
  };
  if (ep in map) return map[ep];
  if (ep.startsWith("/models/")) return { upstreamPath: ep };
  return null;
}

async function handleModelsList(res: NextApiResponse): Promise<void> {
  const env = await createPagesEnv();
  await refreshCache(dummyDb, env);
  const models: Array<{ id: string; object: string; owned_by: string }> = [];
  const pc = getPlatformCache(), pm = getPlatformModelCache();
  for (const [pid, ms] of pm) {
    const p = pc.find(x => x.id === pid);
    for (const mid of ms) models.push({ id: mid, object: "model", owned_by: p?.name ?? "unknown" });
  }
  res.status(200).json({ object: "list", data: models });
}

async function handleModelDetail(modelId: string, res: NextApiResponse): Promise<void> {
  const env = await createPagesEnv();
  await refreshCache(dummyDb, env);
  const pc = getPlatformCache(), pm = getPlatformModelCache();
  for (const [pid, ms] of pm) {
    if (ms.has(modelId)) {
      const p = pc.find(x => x.id === pid);
      res.status(200).json({ id: modelId, object: "model", owned_by: p?.name ?? "unknown" }); return;
    }
  }
  res.status(404).json({ error: { message: `模型 ${modelId} 不存在`, type: "invalid_request_error" } });
}

async function proxyV1RequestPages(req: NextApiRequest, res: NextApiResponse, config: ProxyConfig, apiKey: ApiKeyRecord): Promise<void> {
  const startTime = Date.now();
  const env = await createPagesEnv();
  const logTag = `[v1-proxy:${config.upstreamPath}]`;

  const parseResult = await parseRequestBody<Record<string, unknown>>(req);
  if ("error" in parseResult) { sendV1Error(res, config, 400, parseResult.error, "invalid_request_error"); return; }
  const rawBody = parseResult.body;
  let body = rawBody;

  // Anthropic 协议：下游 /v1/messages 请求体 → OpenAI /chat/completions 请求体。
  // 转换后 model/max_tokens/stream 字段名与语义对齐，后续路由/限流/重试管道原样复用
  if (config.buildUpstreamBody) {
    try {
      body = config.buildUpstreamBody(body);
    } catch (err) {
      if (err instanceof AnthropicRequestError) {
        sendV1Error(res, config, 400, err.message, "invalid_request_error");
        return;
      }
      throw err;
    }
  }

  const modelName = body.model as string | undefined;
  const requestedModel = modelName || "unknown";
  const route = modelName ? await routeRequest(modelName, dummyDb, env) : await routeRequest("__any__", dummyDb, env);
  if (!route) {
    // 路由失败（模型不存在/无平台支持）：platformId 未知记 null，补全请求失败记录
    try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: null, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 500, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "此模型不存在", db: dummyDb, env }); } catch {}
    sendV1Error(res, config, 500, "此模型不存在", "server_error"); return;
  }

  const pRpm = await checkPlatformRpm(route.platform.id, route.platform.rpmLimit);
  if (!pRpm.allowed) {
    // 请求未发出：释放半开探测配额（否则被门禁拒绝的探测槽位永远不归还）
    releaseHalfOpenPending(route.platform.id);
    // 平台级限流反映平台过载/配额耗尽，计入该平台错误统计（Key 级限流是客户端行为，不记录避免污染平台评分）
    try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: route.platform.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 429, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "上游平台请求频率超限", db: dummyDb, env }); } catch {}
    sendV1Error(res, config, 429, "上游平台请求频率超限", "rate_limit_error", { retry_after: Math.ceil((pRpm.resetAt - Date.now()) / 1000) }); return;
  }
  const kRpm = await checkApiKeyRpm(apiKey.id, apiKey.rpmLimit);
  if (!kRpm.allowed) { releaseHalfOpenPending(route.platform.id); sendV1Error(res, config, 429, "API Key 请求频率超限", "rate_limit_error", { retry_after: Math.ceil((kRpm.resetAt - Date.now()) / 1000) }); return; }
  // max_tokens 仅是输出上限，客户端可能传极大值，钳制到 MAX_ESTIMATED_TOKENS
  const est = Math.min(MAX_ESTIMATED_TOKENS, Math.max(1, Number(body.max_tokens || body.max_completion_tokens) || 1));
  // Anthropic 转换器的 message_start.usage.input_tokens：用转换前请求体的输入估算
  // （max_tokens 是输出上限，语义不符；仅限流 TPM 继续用 est）
  const anthropicInputEstimate = config.protocol === "anthropic" ? estimateInputTokens(rawBody) : est;
  const pTpm = await checkPlatformTpm(route.platform.id, route.platform.tpmLimit, est);
  if (!pTpm.allowed) {
    // 请求未发出：释放半开探测配额
    releaseHalfOpenPending(route.platform.id);
    // 平台级 TPM 限流计入该平台错误统计（与平台 RPM 一致；Key 级不记录）
    try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: route.platform.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 429, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "上游平台 Token 速率超限", db: dummyDb, env }); } catch {}
    sendV1Error(res, config, 429, "上游平台 Token 速率超限", "rate_limit_error", { retry_after: Math.ceil((pTpm.resetAt - Date.now()) / 1000) }); return;
  }
  const kTpm = await checkApiKeyTpm(apiKey.id, apiKey.tpmLimit, est);
  if (!kTpm.allowed) { releaseHalfOpenPending(route.platform.id); sendV1Error(res, config, 429, "API Key Token 速率超限", "rate_limit_error", { retry_after: Math.ceil((kTpm.resetAt - Date.now()) / 1000) }); return; }

  const MAX_UPSTREAM_RETRIES = 3;
  const isStream = config.supportsStreaming !== false && body.stream === true;
  let cur = route.platform; const tgt = route.targetModel;
  let curKey = getNextKey(cur);
  const tried = new Set<string>(), triedP = new Set<string>();

  if (!curKey) {
    triedP.add(cur.id);
    for (const p of getPlatformsForModel(tgt, triedP)) { const k = getNextKey(p); if (k) { cur = p; curKey = k; break; } }
    if (!curKey) {
      // 全部平台无可用 Key：平台维度未知记 null（配置问题，不计入任何平台评分）
      try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: null, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 500, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "所有平台均无可用 API Key", db: dummyDb, env }); } catch {}
      sendV1Error(res, config, 500, "所有平台均无可用 API Key", "server_error"); return;
    }
  }

  for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt++) {
    if (curKey) tried.add(curKey);
    triedP.add(cur.id);
    if (!curKey) {
      // 当前平台 Key 耗尽（同平台换 Key 失败）：计入该平台错误统计
      try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 500, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: `平台 "${cur.name}" 无可用 API Key`, db: dummyDb, env }); } catch {}
      sendV1Error(res, config, 500, `平台 "${cur.name}" 无可用 API Key`, "server_error"); return;
    }

    // 模板先作用于原始 OpenAI 请求体；Anthropic 分支随后转换——转换白名单会剥离
    // 模板中的 OpenAI 专属字段（stream_options/n/response_format 等），避免严格后端 422
    let upstreamBody: Record<string, unknown> = { ...body, model: tgt };
    try { const t = await loadTemplates(dummyDb, env); const a = getApplicableTemplates(t, requestedModel); if (a.length > 0) upstreamBody = applyTemplates(upstreamBody, a); } catch {}
    // 上游为 Anthropic 协议：请求体转回 /v1/messages 格式，URL 指向 /v1/messages，
    // 认证用 x-api-key + anthropic-version
    const upstreamIsAnthropic = cur.type === "anthropic";
    if (upstreamIsAnthropic) {
      try {
        upstreamBody = convertOpenAIRequest(upstreamBody);
      } catch (convertError) {
        if (convertError instanceof OpenAIRequestError) {
          sendV1Error(res, config, 400, convertError.message, "invalid_request_error");
          return;
        }
        throw convertError;
      }
    }
    // 流式请求注入 stream_options：仅当平台开启了注入开关时添加
    // 部分严格后端（Mistral 等 FastAPI/pydantic 校验）拒绝未知字段，返回 422 extra_forbidden
    // 用户可在平台管理页关闭此选项以兼容这类上游
    // Anthropic 协议上游同样拒绝未知字段，且 convertOpenAIRequest 已白名单剥离
    if (isStream && cur.injectStreamOptions !== false && !upstreamIsAnthropic) upstreamBody.stream_options = { include_usage: true };

    const fwd: Record<string, string> = {};
    // NextApiRequest.headers 是 IncomingHttpHeaders（可能含 string[] 多值头），
    // 转成 Headers 以匹配 Worker 版 extractForwardableHeaders 签名
    const downstreamHeaders = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") downstreamHeaders.set(k, v);
    for (const [k, v] of Object.entries(extractForwardableHeaders(downstreamHeaders, cur.forwardHeaders)))
      // 认证类/语义类头名（大小写不敏感）直接丢弃：下游透传白名单不得覆盖
      // 平台密钥与请求语义（见 FORBIDDEN_FORWARD_HEADERS 注释）
      if (/^[a-zA-Z0-9-]+$/.test(k) && !FORBIDDEN_FORWARD_HEADERS.has(k.toLowerCase())) fwd[k] = v;

    const url = upstreamIsAnthropic
      ? `${cur.baseUrl.replace(/\/+$/, "")}/v1/messages`
      : `${cur.baseUrl.replace(/\/+$/, "")}${config.upstreamPath}`;
    const check = isSafeUpstreamUrl(cur.baseUrl);
    if (!check.safe) {
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 400, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: `上游 URL 不安全: ${check.reason}`, db: dummyDb, env }).catch(() => {});
      sendV1Error(res, config, 400, `上游 URL 不安全: ${check.reason}`, "invalid_request_error"); return;
    }

    // 注意：fetch resolve 后不立即 clearTimeout，signal 继续保护后续响应体读取；
    // 各分支（流式/非流式/错误）按需清理。
    let upRes: Response;
    const upstreamController = new AbortController();
    const upstreamTimeoutId = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
    const headers = new Headers({
      "Content-Type": "application/json",
      // Anthropic 协议上游：x-api-key + anthropic-version（extraHeaders 可覆盖为
      // Authorization 等，GitHub Copilot 等 OAuth 网关需用户自行配置）
      ...(upstreamIsAnthropic ? { "x-api-key": curKey, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${curKey}` }),
      ...fwd,
      ...parseExtraHeaders(cur.extraHeaders),
    });
    // 高级设置：UA 复用（自定义 UA 优先级最高，覆盖 extraHeaders 中的 User-Agent）
    if (cur.reuseUserAgent && cur.customUserAgent) {
      headers.set("User-Agent", cur.customUserAgent);
    }
    // 出站代理选择结果需在 catch 中回标记，提升到 try 外声明（try/catch 不同块作用域）
    let proxy: Awaited<ReturnType<typeof getUpstreamProxy>> | null = null;
    try {
      // 出站代理（仅 Docker 部署，DEPLOY_PLATFORM=docker）：上游请求经代理
      // 服务器出网；其他部署形态返回 null（直连），边缘运行时不受影响
      proxy = await getUpstreamProxy(dummyDb, env, cur.id);
      upRes = await fetch(url, { method: "POST", headers, body: JSON.stringify(upstreamBody), signal: upstreamController.signal, redirect: "manual", ...(proxy.dispatcher ? { dispatcher: proxy.dispatcher } : {}) });
    }
    catch (e) {
      clearTimeout(upstreamTimeoutId);
      if (e instanceof DOMException && e.name === "AbortError") {
        // 上游请求超时（未收到响应头）：计入该平台错误统计
        if (proxy?.url) recordProxyTraffic(proxy.url, 504);
        void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 504, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "上游请求超时", proxyUrl: proxy?.url ?? undefined, db: dummyDb, env }).catch(() => {});
        sendV1Error(res, config, 504, "上游请求超时", "timeout_error"); return;
      }
      // 网络层失败（非超时）：回标记当前代理，连续失败达阈值后轮询跳过；
      // 补落请求日志（status=0），否则真实失败不出现在 request_logs——
      // 统计可用率高估且与降权统计（recordProxyTraffic 记 errOther）口径矛盾
      if (proxy?.url) {
        recordProxyTraffic(proxy.url, 0);
        void markProxyFailure(dummyDb, env, proxy.url).catch(() => {});
        void recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: cur.id,
          model: requestedModel,
          endpoint: config.upstreamPath,
          method: "POST",
          status: 0,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          ttft: 0,
          duration: Date.now() - startTime,
          isError: true,
          errorMessage: e instanceof Error ? e.message : String(e),
          proxyUrl: proxy.url,
          db: dummyDb,
          env,
        }).catch(() => {});
      }
      throw e;
    }

    // ── 2xx 成功响应：正常处理（流式/非流式）──
    // 上游返回空响应（2xx + 空 body/空流）时 handleUpstreamResponsePages 返回哨兵，
    // 判定为无效，与 429/401/403 一样纳入重试（封禁当前 Key → 换 Key → 换平台）
    // 注意：redirect:"manual" 后 3xx 不再进入此分支，落入下方不可重试分支透传
    let isEmptyResponse = false;
    if (upRes.status >= 200 && upRes.status < 300) {
      const handled = await handleUpstreamResponsePages(upRes, cur, apiKey, requestedModel, config, isStream, startTime, env, est, anthropicInputEstimate, logTag, res, upstreamController, upstreamTimeoutId, proxy?.url ?? undefined, curKey);
      if (handled !== EMPTY_UPSTREAM_RESPONSE) return;
      isEmptyResponse = true;
    }

    // ── 5xx 等不可重试错误：真实透传状态码 + 熔断 + 错误日志 ──
    // 此前流式分支硬编码 200 透传任何非 429 状态，401/403/5xx 被伪装成成功，
    // 下游收到"200 + 空响应"，熔断器与 Key 封禁机制被完全架空。
    if (!isEmptyResponse && !RETRYABLE_UPSTREAM_STATUSES.has(upRes.status)) {
      let errText = "";
      try { errText = await upRes.text(); } catch { /* 读取错误体失败（如 signal 超时） */ }
      clearTimeout(upstreamTimeoutId);
      try { await recordFailure(cur.id, dummyDb, env); } catch {}
      if (proxy?.url) recordProxyTraffic(proxy.url, upRes.status);
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: upRes.status, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: errText.substring(0, 1000), proxyUrl: proxy?.url ?? undefined, db: dummyDb, env }).catch(() => {});
      res.setHeader("Content-Type", "application/json");
      if (config.protocol === "anthropic") {
        res.status(upRes.status).json(formatAnthropicError(upRes.status, extractUpstreamErrorMessage(errText)));
      } else {
        res.status(upRes.status).send(sanitizeUpstreamError(errText, upRes.status));
      }
      return;
    }

    // ── 429/401/403/空响应：封禁当前 Key 并尝试切换 ──
    if (attempt < MAX_UPSTREAM_RETRIES) {
      // 本次尝试失败（429/401/403/空响应）独立记日志：被重试覆盖的错误平台也必须进入
      // 平台错误统计，否则评分只见最终成功平台、错误率被严重低估
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: isEmptyResponse ? 502 : upRes.status, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: isEmptyResponse ? "上游返回空响应（重试切换）" : `上游 ${upRes.status}（已封禁该 Key 并重试切换）`, proxyUrl: proxy?.url ?? undefined, db: dummyDb, env }).catch(() => {});
      if (proxy?.url) recordProxyTraffic(proxy.url, isEmptyResponse ? 502 : upRes.status);
      await banKey(curKey, undefined, cur.id, env?.KV);
      // 累加错误计数并持久化到数据库（429→+1, 401→+2, 其余→+1，达 5 次自动禁用）
      void recordKeyError(curKey, isEmptyResponse ? 502 : upRes.status, cur.id, dummyDb, env).catch(() => {});
      console.log(`${logTag} 上游 ${upRes.status}${isEmptyResponse ? "（空响应）" : ""} (平台: ${cur.name}, attempt: ${attempt + 1}/${MAX_UPSTREAM_RETRIES})，已封禁该 Key 5 分钟，尝试切换`);
      // 清理本次尝试的超时定时器，避免泄漏
      clearTimeout(upstreamTimeoutId);
      // 消费本次失败的响应体，避免 undici keep-alive 连接泄漏（空响应分支 body 已
      // 被 handleUpstreamResponsePages 消费过，此处 arrayBuffer 会 reject 被吞，安全）
      void upRes.arrayBuffer().catch(() => {});
      const nk = getRandomKeyExcept(cur, tried);
      if (nk) { curKey = nk; continue; }
      const ops = getPlatformsForModel(tgt, triedP);
      if (ops.length > 0) {
        // 复用 selectPlatform 过滤熔断 open 平台并按优先级/权重选择（与 Worker 版一致）
        const nextPlatform = selectPlatform(ops);
        if (nextPlatform) { cur = nextPlatform; curKey = getNextKey(cur); continue; }
      }
    }

    // 最后一次尝试或无处可切换：返回真实状态
    let errText = "";
    try { errText = await upRes.text(); } catch { /* 读取错误体失败（如 signal 超时） */ }
    clearTimeout(upstreamTimeoutId);
    try { await recordFailure(cur.id, dummyDb, env); } catch {}
    // 日志 status 记录实际返回下游的状态：空响应耗尽时下游收到 502，
    // 不再记上游的 200（此前记上游实际状态导致管理后台显示"成功"）
    void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: isEmptyResponse ? 502 : upRes.status, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: isEmptyResponse ? "上游返回空响应" : errText.substring(0, 1000), proxyUrl: proxy?.url ?? undefined, db: dummyDb, env }).catch(() => {});
    if (proxy?.url) recordProxyTraffic(proxy.url, isEmptyResponse ? 502 : upRes.status);
    // 自动模型冻结：冻结实际发送的目标模型（tgt）——冻结 requestedModel（自动模型 ID）
    // 与 routeRequest 检查的候选具体模型名不相等，冻结机制从未命中
    if (isAutoModelRequest(requestedModel)) freezeAutoModel(tgt);
    // 空响应特判：绝不向下游透传空响应，返回 502 + 明确错误
    if (isEmptyResponse) {
      res.setHeader("Content-Type", "application/json");
      if (config.protocol === "anthropic") {
        res.status(502).json(formatAnthropicError(502, "上游返回空响应，请求已重试仍无内容"));
      } else {
        res.status(502).send(JSON.stringify({ error: { message: "上游返回空响应，请求已重试仍无内容", type: "upstream_error", upstream_status: upRes.status } }));
      }
      return;
    }
    res.setHeader("Content-Type", "application/json");
    if (config.protocol === "anthropic") {
      res.status(upRes.status).json(formatAnthropicError(upRes.status, extractUpstreamErrorMessage(errText)));
    } else {
      res.status(upRes.status).send(sanitizeUpstreamError(errText, upRes.status));
    }
    return;
  }
}

async function handleUpstreamResponsePages(upRes: Response, platform: { id: string; name: string; type?: string }, apiKey: ApiKeyRecord, model: string, config: ProxyConfig, isStream: boolean, start: number, env: WorkerEnv & { KV?: KVNamespace; DB?: D1Database }, est: number, anthropicInputEstimate: number, tag: string, res: NextApiResponse, upstreamController: AbortController, upstreamTimeoutId: ReturnType<typeof setTimeout>, proxyUrl?: string, /** 本次请求使用的上游平台 Key 明文：流内密钥类错误（429/401/402/403）时封禁+计数；不传则跳过密钥级处理 */ platformKey?: string): Promise<void | typeof EMPTY_UPSTREAM_RESPONSE> {
  // 上游是否为 Anthropic 协议：响应需先转成 OpenAI 内部格式再走 usage/下游转换管线
  const upstreamIsAnthropic = platform.type === "anthropic";
  if (isStream) {
    const s = upRes.body;
    if (!s) { clearTimeout(upstreamTimeoutId); try { await recordFailure(platform.id, dummyDb, env); } catch {} sendV1Error(res, config, 500, "上游未返回流式响应", "server_error"); return; }
    const r = s.getReader();
    // 客户端断开（关页面/网络切换）：取消上游流并停止写入，避免上游连接悬挂
    let clientClosed = false;
    res.on("close", () => {
      clientClosed = true;
      r.cancel().catch(() => {});
    });
    // 吞掉连接重置错误（客户端断开时 write/end 可能触发），避免未捕获异常
    res.on("error", () => {});
    // 先读第一块判断是否为空流：200 + 空 SSE 视为空响应，交由调用方重试；
    // 等待第一块仍受总超时（signal）保护
    let first: ReadableStreamReadResult<Uint8Array>;
    try { first = await r.read(); }
    catch {
      clearTimeout(upstreamTimeoutId);
      if (upstreamController.signal.aborted) { sendV1Error(res, config, 504, "上游响应读取超时", "timeout_error"); return; }
      sendV1Error(res, config, 500, "读取上游响应失败", "server_error"); return;
    }
    if (first.done) { clearTimeout(upstreamTimeoutId); r.releaseLock(); return EMPTY_UPSTREAM_RESPONSE; }
    // 首块已到达：记录 TTFT（与 Worker 版 createUsageTransformer 语义一致——首个 chunk 到达时间与请求开始之差）
    const ttft = Date.now() - start;
    // 总超时使命完成：流式响应允许长时间持续传输，改由空闲超时保护（无数据才切断）
    clearTimeout(upstreamTimeoutId);
    // 不阻塞首字节：recordSuccess 在 half-open 恢复时会写库（TiDB/远端 DB 可达秒级），
    // 若在设置 SSE headers 前 await，客户端 TTFB 会被拖到秒级（实测 9.95s）
    void recordSuccess(platform.id, dummyDb, env).catch(() => {});
    // no-transform：阻止 next start（Node 服务器）内置 gzip 压缩流式响应。
    // compression 中间件会把每个 write 导入 zlib 流，输出攒够 16KB 才下发，
    // 导致思考内容被整体缓冲、首字节随思考延伸而推迟，且大响应尾部有截断风险。
    res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache, no-transform"); res.setHeader("Connection", "keep-alive");
    const d = new TextDecoder();
    let tt = 0, pt = 0, ct = 0, buf = "";
    // SSE 行缓冲上限：防异常/恶意上游发送无换行的超长数据导致内存无限增长
    const MAX_SSE_BUFFER_BYTES = 1024 * 1024;
    // 带背压的写入：write 返回 false（写缓冲超过 highWaterMark）时暂停读取，
    // 等 drain 或客户端断开后继续，避免慢客户端下内存写缓冲无限增长；
    // 停滞客户端（连接保持但不读，TCP 窗口满）drain/close 永不触发，超时后
    // 取消上游流并终止转发，避免处理器被永久挂起（此前无超时会被无限阻塞）
    const WRITE_DRAIN_TIMEOUT_MS = 30_000;
    const writeChunk = async (chunk: string) => {
      if (clientClosed) return;
      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            res.off("drain", onDrain);
            res.off("close", onClose);
            resolve();
          };
          const onDrain = () => finish();
          const onClose = () => { clientClosed = true; finish(); };
          const timer = setTimeout(() => {
            clientClosed = true;
            r.cancel().catch(() => {});
            finish();
          }, WRITE_DRAIN_TIMEOUT_MS);
          res.once("drain", onDrain);
          res.once("close", onClose);
        });
      }
    };
    // 流内 error 事件（上游 200 + data: {"error": ...}）：HTTP 头无法反映失败，日志须按错误码记录
    let streamError: { code: number; message: string } | undefined;
    // 上游正常结束的标志：SSE 流必须以 data: [DONE] 收尾。
    // 上游在思考中途截断（EOF 但无 [DONE]，如部分 zen-proxy 入口 ~10s 截断）时，
    // 若按成功记录，坏平台永远不会被熔断，负载均衡会反复撞上它。
    let sawDone = false;
    let lastChunkAt = Date.now();
    let idleTimedOut = false;
    // Anthropic 协议：OpenAI SSE chunk → Anthropic 事件流（message_start → ... → message_stop）。
    // message_start.usage.input_tokens 用转换前请求体的输入估算（max_tokens 是输出上限，语义不符）
    const streamer = config.protocol === "anthropic" ? new OpenAIToAnthropicStream({ model, inputTokens: anthropicInputEstimate }) : null;
    // 上游为 Anthropic 协议：Anthropic 事件 → OpenAI chunk（usage/[DONE]/error 语义统一）
    const upstreamStreamer = upstreamIsAnthropic ? new AnthropicToOpenAIStream() : null;
    // 看门狗：距上次收到数据超过 UPSTREAM_IDLE_TIMEOUT_MS 即取消上游流，避免函数被无数据流无限占用
    const watchdog = setInterval(() => {
      if (Date.now() - lastChunkAt > UPSTREAM_IDLE_TIMEOUT_MS) {
        idleTimedOut = true;
        r.cancel().catch(() => {});
      }
    }, 15_000);
    // 已读到的第一块先进入处理队列，避免数据丢失
    let pendingChunk = first.value;
    try {
      while (true) {
        if (idleTimedOut || clientClosed) break;
        buf += d.decode(pendingChunk, { stream: true });
        // 缓冲超限：取消上游流并终止（走下方 !sawDone 分支记录失败与熔断）
        if (buf.length > MAX_SSE_BUFFER_BYTES) {
          r.cancel().catch(() => {});
          break;
        }
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const raw of lines) {
          // CRLF 上游（行尾 \r）：只去除 \r 再判断，避免 [DONE]/data: 前缀匹配
          // 失败误判截断；不 trimEnd 剥掉全部行尾空白，OpenAI 直通分支的
          // 纯文本 data 行行尾空格需原样透传
          const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (l === "data: [DONE]") { sawDone = true; if (!streamer) await writeChunk(l + "\n"); continue; }
          if (!l.startsWith("data: ")) {
            // 非 data 行（空行分隔符等）：OpenAI 分支原样透传；
            // 上游 Anthropic 的 event: 行由转换器消费，丢弃
            if (!streamer && !upstreamStreamer) await writeChunk(l + "\n");
            continue;
          }
          try {
            const data = JSON.parse(l.slice(6));
            // 上游 Anthropic：Anthropic 事件 → OpenAI chunk（可能产出多行 SSE）
            const outLines = upstreamStreamer
              ? upstreamStreamer.feedData(data).split("\n").filter((x) => x.length > 0)
              : [l];
            for (const ol of outLines) {
              if (ol === "data: [DONE]") { sawDone = true; if (!streamer) await writeChunk(ol + "\n"); continue; }
              try {
                const d = JSON.parse(ol.slice(6));
                if (d.usage) { const ex = extractUsage(d.usage, est); tt = ex.totalTokens; pt = ex.promptTokens; ct = ex.completionTokens; }
                if (d.error) { /* 与 Worker 版 resolveStreamErrorStatus 保持一致的语义：仅 400-599 整数视为错误码（浮点等病态值会让 Prisma Int 校验失败、日志整条丢失） */ const rawCode = d.error.code; const code = typeof rawCode === "number" ? rawCode : typeof rawCode === "string" ? parseInt(rawCode, 10) : NaN; if (!Number.isNaN(code) && Number.isInteger(code) && code >= 400 && code <= 599) { streamError = { code, message: String(d.error.message || "").substring(0, 1000) }; } }
                if (streamer) {
                  // 纯 usage chunk（无 choices 键）也可能携带 output_tokens，不能过滤掉
                  if (d.choices || d.usage) await writeChunk(streamer.feedChunk(d));
                } else {
                  await writeChunk(ol + "\n");
                }
              } catch {}
            }
          } catch {}
        }
        const { done, value } = await r.read();
        if (done) break;
        lastChunkAt = Date.now();
        pendingChunk = value;
      }
      if (streamer) {
        if (streamError || idleTimedOut) {
          // 流内 error / 空闲超时：Anthropic 客户端靠 event: error 感知失败，不能再发正常收尾（message_stop）
          const code = streamError?.code ?? 504;
          const message = streamError?.message ?? `上游响应空闲超时（${UPSTREAM_IDLE_TIMEOUT_MS / 1000} 秒无数据）`;
          await writeChunk(`event: error\ndata: ${JSON.stringify(formatAnthropicError(code, message))}\n\n`);
        } else {
          // Anthropic 收尾：关闭内容块 → message_delta（stop_reason/usage）→ message_stop
          await writeChunk(streamer.finish());
        }
      } else if (buf) {
        // 上游 Anthropic 时 buf 残留的是 event: 行等转换器已消费的行，不写出
        if (!upstreamStreamer) await writeChunk(buf + "\n");
      }
    } catch (e) {
      if (!idleTimedOut && !clientClosed) console.error(`${tag} 流式错误:`, e instanceof Error ? e.message : String(e));
    } finally {
      clearInterval(watchdog);
    }
    if (idleTimedOut) {
      // 空闲超时与 EOF 截断同属上游失败：触发平台熔断，否则挂起平台评分不降、
      // 负载均衡反复撞上同一坏平台（此前只补日志不打分，熔断机制被架空）
      try { await recordFailure(platform.id, dummyDb, env); } catch {}
      if (proxyUrl) recordProxyTraffic(proxyUrl, 504);
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 504, tokens: 0, promptTokens: 0, completionTokens: 0, ttft, duration: Date.now() - start, isError: true, errorMessage: `上游响应空闲超时（${UPSTREAM_IDLE_TIMEOUT_MS / 1000} 秒无数据）`, proxyUrl, db: dummyDb, env }).catch(() => {});
    } else if (streamError) {
      // 流内 error：HTTP 头无法反映失败（下游实际收到 200 + error 流），
      // 按错误码记失败日志（不计 Key 用量）并触发平台熔断——此前只记日志不打分，
      // 坏平台永远不会被降级，负载均衡反复撞上它（与 Worker 版 createUsageTransformer
      // flush 语义一致）
      try { await recordFailure(platform.id, dummyDb, env); } catch {}
      // 流内 error 为密钥类状态码（429/401/402/403）时与 HTTP 重试路径对齐：
      // 封禁当前平台 Key + 累计错误计数（errorCount 达阈值自动禁用）；白名单密钥
      // 由 banKey/recordKeyError 内部豁免（仅降级不计数）。404/503 等非密钥错误不打 Key 分
      if (platformKey && (streamError.code === 429 || streamError.code === 401 || streamError.code === 402 || streamError.code === 403)) {
        try { await banKey(platformKey, undefined, platform.id, env?.KV); } catch {}
        try { await recordKeyError(platformKey, streamError.code, platform.id, dummyDb, env); } catch {}
      }
      if (proxyUrl) recordProxyTraffic(proxyUrl, streamError.code);
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: streamError.code, tokens: 0, promptTokens: 0, completionTokens: 0, ttft, duration: Date.now() - start, isError: true, errorMessage: streamError.message, proxyUrl, db: dummyDb, env }).catch(() => {});
    } else if (!sawDone && !clientClosed) {
      // 上游流被截断：EOF 但未收到 [DONE]（如部分 zen-proxy 入口对长思考流 ~10s 截断）。
      // 客户端已收到 200 + 部分流无法改写状态码，但必须记失败并触发熔断，
      // 否则坏平台永远不会被降级，负载均衡会反复撞上它（此前一直记 200 成功）。
      // 客户端主动断开时不走此分支（流未读完是断开所致，非上游失败，不应触发熔断）
      try { await recordFailure(platform.id, dummyDb, env); } catch {}
      if (proxyUrl) recordProxyTraffic(proxyUrl, 502);
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 502, tokens: 0, promptTokens: 0, completionTokens: 0, ttft, duration: Date.now() - start, isError: true, errorMessage: "上游流未正常结束（EOF 但未收到 [DONE]），疑似上游截断", proxyUrl, db: dummyDb, env }).catch(() => {});
    } else {
      if (tt > 0) { try { await updateKeyUsage(apiKey.id, tt, dummyDb, env); } catch {} }
      if (proxyUrl) recordProxyTraffic(proxyUrl, 200);
      try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: tt, promptTokens: pt, completionTokens: ct, ttft, duration: Date.now() - start, isError: false, proxyUrl, db: dummyDb, env }); } catch {}
    }
    try { res.end(); } catch { /* 客户端已断开，忽略结束写入错误 */ }
    return;
  }
  const ct = upRes.headers.get("content-type") || "";
  if (ct.includes("multipart/")) {
    let ab: ArrayBuffer;
    try { ab = await upRes.arrayBuffer(); } catch { clearTimeout(upstreamTimeoutId); if (upstreamController.signal.aborted) { sendV1Error(res, config, 504, "上游响应读取超时", "timeout_error"); return; } try { await recordFailure(platform.id, dummyDb, env); } catch {} sendV1Error(res, config, 500, "读取上游响应失败", "server_error"); return; }
    clearTimeout(upstreamTimeoutId);
    // 空响应：空 multipart 视为空响应，交由调用方重试
    if (ab.byteLength === 0) return EMPTY_UPSTREAM_RESPONSE;
    // 不阻塞响应：写库后置为 fire-and-forget（与流式分支一致）
    void recordSuccess(platform.id, dummyDb, env).catch(() => {}); if (proxyUrl) recordProxyTraffic(proxyUrl, 200); void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - start, isError: false, proxyUrl, db: dummyDb, env }).catch(() => {});
    res.setHeader("Content-Type", ct); res.status(200).send(Buffer.from(ab)); return;
  }
  let body: string;
  try { body = await upRes.text(); }
  catch {
    clearTimeout(upstreamTimeoutId);
    if (upstreamController.signal.aborted) { sendV1Error(res, config, 504, "上游响应读取超时", "timeout_error"); return; }
    await recordFailure(platform.id, dummyDb, env); sendV1Error(res, config, 500, "读取上游响应失败", "server_error"); return;
  }
  clearTimeout(upstreamTimeoutId);
  // 空响应：2xx 但响应体为空（上游返回空 body），判定无效交由调用方重试
  if (!body.trim()) return EMPTY_UPSTREAM_RESPONSE;
  let rt = 0, rpt = 0, rct = 0;
  // 上游为 Anthropic 协议：先转成 OpenAI 内部格式（usage 提取与下游转换共用同一对象）；
  // 转换失败（非 JSON / 结构异常）时 openaiBody 为 null，交由下方 502 分支处理
  let openaiBody: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(body) as Record<string, unknown>;
    openaiBody = upstreamIsAnthropic ? convertAnthropicResponse(p, model) : p;
    if (openaiBody.usage) { const ex = extractUsage(openaiBody.usage as Record<string, unknown>, est); rt = ex.totalTokens; rpt = ex.promptTokens; rct = ex.completionTokens; if (rt > 0) void updateKeyUsage(apiKey.id, rt, dummyDb, env).catch(() => {}); }
  } catch {}
  res.setHeader("Content-Type", "application/json");
  if (config.protocol === "anthropic") {
    // OpenAI chat.completion → Anthropic message（回显下游请求的模型名）
    try {
      if (!openaiBody) throw new Error("unparseable");
      const converted = JSON.stringify(convertOpenAIResponse(openaiBody, model));
      // 转换成功后才记成功日志/用量，避免转换失败时留下"200 成功"的误导记录
      if (proxyUrl) recordProxyTraffic(proxyUrl, 200);
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: rt, promptTokens: rpt, completionTokens: rct, ttft: 0, duration: Date.now() - start, isError: false, proxyUrl, db: dummyDb, env }).catch(() => {});
      void recordSuccess(platform.id, dummyDb, env).catch(() => {});
      res.status(200).send(converted);
    } catch {
      try { await recordFailure(platform.id, dummyDb, env); } catch {}
      if (proxyUrl) recordProxyTraffic(proxyUrl, 502);
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 502, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - start, isError: true, errorMessage: "上游响应格式错误", proxyUrl, db: dummyDb, env }).catch(() => {});
      res.status(502).json(formatAnthropicError(502, "上游响应格式错误"));
    }
    return;
  }
  if (proxyUrl) recordProxyTraffic(proxyUrl, upRes.status);
  void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: upRes.status, tokens: rt, promptTokens: rpt, completionTokens: rct, ttft: 0, duration: Date.now() - start, isError: false, proxyUrl, db: dummyDb, env }).catch(() => {});
  void recordSuccess(platform.id, dummyDb, env).catch(() => {});
  // 上游为 Anthropic 协议时下游收到的是转换后的 OpenAI 格式（openaiBody 解析失败
  // 时保持透传原文，与 OpenAI 上游非 JSON 响应行为一致）
  res.status(upRes.status).send(upstreamIsAnthropic && openaiBody ? JSON.stringify(openaiBody) : body);
}

/** 提取 API Key：兼容 Anthropic 客户端（x-api-key 头）与 OpenAI 客户端（Authorization: Bearer） */
function getApiKeyHeader(req: NextApiRequest): string | undefined {
  const pick = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
  // authorization 优先，回退 x-api-key；空值（空串头）也回退，避免空 Authorization 遮蔽有效 x-api-key
  return pick(req.headers.authorization) || pick(req.headers["x-api-key"]);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  let cfg: ProxyConfig | undefined;
  try {
    // 首次请求时把真实 D1 binding 同步进 dummyDb：业务模块统一以 { DB: dummyDb }
    // 调用 createDb，若 dummyDb 是空对象，D1 部署下 PrismaD1({}) 抛错被 .catch(()=>{})
    // 吞掉，日志/用量/熔断/错误计数全部静默丢失。
    // 用 promise 闩锁而非先置 dbBound：并发首请求 await 期间若跳过绑定直接用空 DB，
    // PrismaD1({}) 构造的坏实例会被 cachedPrisma 按 dbKind 永久缓存，之后所有请求复用
    if (!dbBound) {
      dbBindPromise ??= (async () => {
        const pagesEnv = await createPagesEnv();
        if (pagesEnv.DB) dummyDb = pagesEnv.DB;
      })();
      try {
        await dbBindPromise;
        dbBound = true;
      } catch (bindErr) {
        // 绑定失败：不置 dbBound，允许下次请求重试（本次请求按外层 catch 失败响应）
        dbBindPromise = null;
        throw bindErr;
      }
    }
    // 首次请求时加载 Key 白名单：recordKeyError / banKey 的豁免判定（isKeyWhitelisted /
    // isPlatformWhitelisted）依赖该内存集合，不加载则白名单在 Pages 部署模式下永不生效；
    // 成功加载后才置 loaded 标志：加载失败时本次请求降级为无白名单继续，下次请求重试——
    // 此前先置位，首次请求遇 DB 瞬时故障则进程生命周期内永不重试，白名单豁免与
    // 持久化禁用恢复永久失效（loadWhitelist 内部已容错，重复并发加载幂等无害）
    if (!whitelistLoaded) {
      // loadWhitelist 返回 boolean（内部容错不抛异常）：成功才置标志，
      // 失败保留可重试——此前 try/catch 空转导致失败也置位，缺陷原样保留
      whitelistLoaded = (await loadWhitelist(dummyDb, await createPagesEnv())) === true;
    }
    // 首次请求时恢复 Key 持久化状态（DB enabled=false 的禁用密钥）：
    // 不恢复则进程重启后自动禁用（402/错误计数达阈值）的密钥复活且不再累计错误；
    // 非 Cloudflare 部署无 KV，loadKeyStatusFromKV 会退化为仅从 DB 恢复禁用集合；
    // 与白名单同模式：成功加载后才置标志，失败保留可重试
    if (!keyStatusLoaded) {
      const pagesEnv = await createPagesEnv();
      // loadKeyStatusFromKV 返回 boolean（内部容错不抛异常）：成功才置标志，失败可重试
      keyStatusLoaded = (await loadKeyStatusFromKV(dummyDb, pagesEnv.KV, pagesEnv)) === true;
    }
    const v1 = (req.query.v1 as string[])?.join("/") || "";
    const full = `/v1/${v1}`;
    // Anthropic /v1/messages/count_tokens：不转发上游，直接估算 token 数
    if (full === "/v1/messages/count_tokens" && req.method === "POST") {
      // 该分支提前 return，先给 cfg 赋值：意外异常也被外层 catch 按 anthropic 协议格式化
      cfg = getEndpointConfig("/v1/messages") ?? undefined;
      const env = await createPagesEnv();
      const auth = await validateApiKey(getApiKeyHeader(req) || null, dummyDb, env);
      if ("error" in auth) {
        const e = auth.error;
        const errBody = await e.json().catch(() => ({})) as { error?: { message?: string } };
        res.status(e.status).json(formatAnthropicError(e.status, errBody?.error?.message || "认证失败"));
        return;
      }
      // 与 Worker 版 count_tokens 一致：超大请求体（Content-Length 预检）直接 413 拒绝
      if (Number(req.headers["content-length"] || "0") > MAX_BODY_BYTES) {
        res.status(413).json(formatAnthropicError(413, "请求体过大"));
        return;
      }
      const parseResult = await parseRequestBody<Record<string, unknown>>(req);
      if ("error" in parseResult) { res.status(400).json(formatAnthropicError(400, parseResult.error)); return; }
      res.status(200).json({ input_tokens: estimateInputTokens(parseResult.body) });
      return;
    }
    const cfgResolved = getEndpointConfig(full);
    if (!cfgResolved) { res.status(404).json({ error: { message: "不支持的 API 端点", type: "invalid_request_error" } }); return; }
    cfg = cfgResolved;
    const env = await createPagesEnv();
    const auth = await validateApiKey(getApiKeyHeader(req) || null, dummyDb, env);
    if ("error" in auth) {
      if (cfg.protocol === "anthropic") {
        const e = auth.error;
        const errBody = await e.json().catch(() => ({})) as { error?: { message?: string } };
        res.status(e.status).json(formatAnthropicError(e.status, errBody?.error?.message || "认证失败"));
      } else {
        const e = auth.error; res.status(e.status).json(await e.json());
      }
      return;
    }
    // GET /v1/models 与 /v1/models/:model — 与其余端点一致放在认证之后：
    // 未认证时不泄露模型清单与平台名（历史漏洞：认证前直接返回列表，可
    // 匿名枚举模型 ID/owned_by，并经响应数据外带盲 SSRF 探测结果）
    if (full === "/v1/models" && req.method === "GET") return await handleModelsList(res);
    // 模型 ID 直接用 full 切片：Next.js 的 catch-all query（req.query.v1）已做
    // 一次 URL 解码，不再 decodeURIComponent（二次解码会误解模型名中的 %xx，
    // 非法转义序列还会抛 URIError 500）；Worker 侧基于原始 pathname 才需显式解码
    if (full.startsWith("/v1/models/") && req.method === "GET") { return await handleModelDetail(full.slice("/v1/models/".length), res); }
    await proxyV1RequestPages(req, res, cfg, auth.apiKey);
  } catch (err) {
    console.error("[v1-proxy] 未捕获异常:", err instanceof Error ? err.message : String(err));
    if (cfg?.protocol === "anthropic") { res.status(500).json(formatAnthropicError(500, "服务器内部错误")); return; }
    res.status(500).json({ error: { message: "服务器内部错误", type: "server_error" } });
  }
}
