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
import { getNextKey, getRandomKeyExcept, banKey, recordKeyError, loadWhitelist, loadKeyStatusFromKV, isPlatformWhitelisted } from "../../../worker/src/platform-keys";
import { recordSuccess, recordFailure, selectPlatform, releaseHalfOpenPending, recordPlatform429 } from "../../../worker/src/load-balancer";
import { extractUsage, updateKeyUsage, recordRequestLog, extractClientInfo } from "../../../worker/src/token";
import { extractForwardableHeaders, parseExtraHeaders } from "../../../worker/src/forward-headers";
import { loadTemplates, getApplicableTemplates, applyTemplates } from "../../../worker/src/request-templates";
import { checkPlatformRpm, checkPlatformTpm, checkApiKeyRpm, checkApiKeyTpm, releasePlatformRpm, releasePlatformTpm } from "@/lib/v1-rate-limit";
import { getUpstreamProxyForKey, markProxyFailure, recordProxyTraffic } from "@/lib/upstream-proxy";
import { isSafeUpstreamUrl } from "@/lib/ssrf";
import { sendNotification } from "@/lib/notifier";
import { saveDebugLog } from "@/lib/debug-log";
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
  // 与 Worker 版 proxy.ts / proxy-lite.ts 保持同一黑名单：下游伪造
  // x-forwarded-* / cf-connecting-ip 等可污染日志 IP 与上游侧来源判定
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "cf-connecting-ip",
  "eo-client-ip",
  "eo-connecting-ip",
  "x-vercel-forwarded-for",
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

/**
 * 对上游原始错误消息进行脱敏，防止敏感信息（如地区封锁策略、内部地址等）泄露给客户端
 * 403/401/429 返回通用消息，其余错误保留原始消息（5xx 错误信息通常不敏感）
 */
function sanitizeMessage(original: string, status: number): string {
  if (status === 403) return "上游访问被拒绝（HTTP 403）";
  if (status === 401) return "上游认证失败（HTTP 401）";
  if (status === 429) return "上游请求过多（HTTP 429）";
  return original;
}

function sanitizeUpstreamError(text: string, status: number): string {
  return JSON.stringify({ error: { message: sanitizeMessage(extractUpstreamErrorMessage(text), status), type: "upstream_error", upstream_status: status } });
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
    if (env.NODE_NAME) process.env.NODE_NAME = env.NODE_NAME;
    if (env.DEPLOY_PLATFORM) process.env.DEPLOY_PLATFORM = env.DEPLOY_PLATFORM;
    return {
      DB_TYPE: env.DB_TYPE,
      DATABASE_URL: env.DATABASE_URL,
      TIDB_URL: env.TIDB_URL,
      PG_URL: env.PG_URL,
      MARIADB_URL: env.MARIADB_URL,
      MYSQL_URL: env.MYSQL_URL,
      NODE_NAME: env.NODE_NAME,
      DEPLOY_PLATFORM: env.DEPLOY_PLATFORM,
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
      NODE_NAME: process.env.NODE_NAME,
      DEPLOY_PLATFORM: process.env.DEPLOY_PLATFORM,
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

/** multipart/form-data 请求体解析结果：仅提取 model 字段用于路由，原始字节转发时透传 */
type MultipartBody = { model: string | null; raw: Buffer; contentType: string };

type ParseBodyResult<T> =
  | { body: T }
  | { multipart: MultipartBody }
  | { error: string; statusCode?: number };

/** 从 multipart body 中提取指定文本字段（latin1 保字节序：仅头部与文本字段为
 *  ASCII，文件二进制不受影响；按 boundary 切分逐 part 查 Content-Disposition） */
function extractMultipartField(raw: Buffer, contentType: string, field: string): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = (m[1] ?? m[2]).trim();
  const text = raw.toString("latin1");
  for (const part of text.split(`--${boundary}`)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd);
    const dm = /name="([^"]*)"/.exec(header);
    if (!dm || dm[1] !== field) continue;
    return part.slice(headerEnd + 4).replace(/\r\n$/, "").trim();
  }
  return null;
}

async function parseRequestBody<T>(req: NextApiRequest): Promise<ParseBodyResult<T>> {
  const cl = Number(req.headers["content-length"] || "0");
  // 请求体超限返回结构化 statusCode 413（与 Worker 版一致）：调用方据此回 413 而非一律 400
  if (cl > MAX_BODY_BYTES) return { error: "请求体过大", statusCode: 413 };
  const contentType = String(req.headers["content-type"] ?? "");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  if (raw.length > MAX_BODY_BYTES) return { error: "请求体过大", statusCode: 413 };
  // 媒体类型不区分大小写：与 Worker/lite 版 parseRequestBody 的 toLowerCase 判定对齐
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    // multipart（images/edits、audio/transcriptions 等）：此前只做 JSON.parse，
    // 标准客户端必然发送 multipart 导致固定 400「请求体格式错误」，端点形同虚设；
    // 现提取 model 用于路由，原始字节连同 Content-Type 原样透传上游
    return { multipart: { model: extractMultipartField(raw, contentType, "model"), raw, contentType } };
  }
  const text = raw.toString("utf-8");
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
  // 同名模型多平台重复：按平台优先级（priority 小者优先）取最优归属去重，
  // 避免客户端模型下拉出现大量同名条目
  const seen = new Set<string>();
  const orderedPids = [...pm.keys()].sort((a, b) => {
    const pa = pc.find(x => x.id === a)?.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = pc.find(x => x.id === b)?.priority ?? Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
  for (const pid of orderedPids) {
    const p = pc.find(x => x.id === pid);
    for (const mid of pm.get(pid) ?? []) {
      if (seen.has(mid)) continue;
      seen.add(mid);
      models.push({ id: mid, object: "model", owned_by: p?.name ?? "unknown" });
    }
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
  // 客户端 IP/UA：所有请求日志（含错误分支）统一携带，日志页与导出的来源列依赖此值
  const clientInfo = extractClientInfo(req);

  const parseResult = await parseRequestBody<Record<string, unknown>>(req);
  if ("error" in parseResult) { sendV1Error(res, config, parseResult.statusCode ?? 400, parseResult.error, "invalid_request_error"); return; }
  // multipart 请求（images/edits、audio/transcriptions 等）：model 从表单字段提取，
  // 原始字节在循环内原样透传上游（JSON 管道字段如 max_tokens/stream 不适用）
  let multipart: MultipartBody | null = null;
  if ("multipart" in parseResult) {
    multipart = parseResult.multipart;
    if (!multipart.model) {
      sendV1Error(res, config, 400, "缺少 model 参数", "invalid_request_error");
      return;
    }
  }
  // TS 联合收窄：in 运算符分支后 parseResult 类型被收窄到 { multipart }，
  // 不能直接写 .body；用 in 三元取回 body 分支（error 分支已提前 return）
  const rawBody = "body" in parseResult
    ? parseResult.body
    : { model: multipart!.model as string };
  let body = rawBody;

  // Anthropic 协议：下游 /v1/messages 请求体 → OpenAI /chat/completions 请求体。
  // 转换后 model/max_tokens/stream 字段名与语义对齐，后续路由/限流/重试管道原样复用
  // （multipart 端点无 Anthropic 协议映射，天然跳过）
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
  if (!modelName) {
    // 客户端漏传 model（/v1/models 之外所有端点必填）：按 4xx 返回，
    // 此前用 "__any__" 兜底恒路由失败返回 500，把客户端错误伪装成
    // 服务器故障并污染错误统计
    sendV1Error(res, config, 400, "缺少 model 参数", "invalid_request_error");
    return;
  }
  const requestedModel = modelName;
  const sourceApi = config.upstreamPath === "/responses" ? "responses" as const : "chat" as const;
  const route = await routeRequest(modelName, dummyDb, env, sourceApi);
  if (!route) {
    // 路由失败（模型不存在/无平台支持）：platformId 未知记 null，补全请求失败记录
    try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: null, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 500, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "此模型不存在", ipAddress: clientInfo.ipAddress, userAgent: clientInfo.userAgent, db: dummyDb, env }); } catch {}
    sendV1Error(res, config, 500, "此模型不存在", "server_error"); return;
  }

  const pRpm = await checkPlatformRpm(route.platform.id, route.platform.rpmLimit);
  if (!pRpm.allowed) {
    // 请求未发出：释放半开探测配额（否则被门禁拒绝的探测槽位永远不归还）
    releaseHalfOpenPending(route.platform.id);
    // 平台级限流反映平台过载/配额耗尽，计入该平台错误统计（Key 级限流是客户端行为，不记录避免污染平台评分）
    try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: route.platform.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 429, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "上游平台请求频率超限", ipAddress: clientInfo.ipAddress, userAgent: clientInfo.userAgent, db: dummyDb, env }); } catch {}
    sendV1Error(res, config, 429, "上游平台请求频率超限", "rate_limit_error", { retry_after: Math.ceil((pRpm.resetAt - Date.now()) / 1000) }); return;
  }
  const kRpm = await checkApiKeyRpm(apiKey.id, apiKey.rpmLimit);
  if (!kRpm.allowed) {
    releaseHalfOpenPending(route.platform.id);
    // Key 级拒绝时平台 RPM 已扣：不归还则配额被与该客户端无关的请求白白消耗；
    // 传扣减时刻的窗口键，跨分钟边界回滚不会误减新窗口计数
    await releasePlatformRpm(route.platform.id, route.platform.rpmLimit, pRpm.windowStart);
    sendV1Error(res, config, 429, "API Key 请求频率超限", "rate_limit_error", { retry_after: Math.ceil((kRpm.resetAt - Date.now()) / 1000) }); return;
  }
  // max_tokens 仅是输出上限，客户端可能传极大值，钳制到 MAX_ESTIMATED_TOKENS
  // Responses 使用 max_output_tokens，Chat 使用 max_tokens/max_completion_tokens。
  // multipart（图片/音频）请求体无 token 字段且实际消耗达数千至数万 token，
  // 按上限预扣，防止 TPM 配额被以 1 token 的名义绕过
  const est = multipart
    ? MAX_ESTIMATED_TOKENS
    : Math.min(MAX_ESTIMATED_TOKENS, Math.max(1, Number((body as any).max_output_tokens || body.max_tokens || body.max_completion_tokens) || 1));
  // Anthropic 转换器的 message_start.usage.input_tokens：用转换前请求体的输入估算
  // （max_tokens 是输出上限，语义不符；仅限流 TPM 继续用 est）
  const anthropicInputEstimate = config.protocol === "anthropic" ? estimateInputTokens(rawBody) : est;
  const pTpm = await checkPlatformTpm(route.platform.id, route.platform.tpmLimit, est);
  if (!pTpm.allowed) {
    // 请求未发出：释放半开探测配额；平台 RPM 已扣同样归还（与 kRpm/kTpm
    // 拒绝分支同一理由——不归则会配额被无关请求白白消耗，放大后续 429）
    releaseHalfOpenPending(route.platform.id);
    await releasePlatformRpm(route.platform.id, route.platform.rpmLimit, pRpm.windowStart);
    // 平台级 TPM 限流计入该平台错误统计（与平台 RPM 一致；Key 级不记录）
    try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: route.platform.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 429, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "上游平台 Token 速率超限", ipAddress: clientInfo.ipAddress, userAgent: clientInfo.userAgent, db: dummyDb, env }); } catch {}
    sendV1Error(res, config, 429, "上游平台 Token 速率超限", "rate_limit_error", { retry_after: Math.ceil((pTpm.resetAt - Date.now()) / 1000) }); return;
  }
  const kTpm = await checkApiKeyTpm(apiKey.id, apiKey.tpmLimit, est);
  if (!kTpm.allowed) {
    releaseHalfOpenPending(route.platform.id);
    // Key 级拒绝时平台 RPM/TPM 均已扣：一并归还，est 与扣减时保持同一预估值，
    // 窗口键传扣减时刻的 windowStart 防跨窗口误减
    await releasePlatformRpm(route.platform.id, route.platform.rpmLimit, pRpm.windowStart);
    await releasePlatformTpm(route.platform.id, route.platform.tpmLimit, est, pTpm.windowStart);
    sendV1Error(res, config, 429, "API Key Token 速率超限", "rate_limit_error", { retry_after: Math.ceil((kTpm.resetAt - Date.now()) / 1000) }); return;
  }

  const MAX_UPSTREAM_RETRIES = 3;
  let cur = route.platform; const tgt = route.targetModel;
  let curKey = getNextKey(cur);
  const tried = new Set<string>(), triedP = new Set<string>();

  if (!curKey) {
    // selectPlatform 可能已为该 half-open 平台占用探测槽位；因无可用 Key
    // 放弃它必须归还（与 Worker 版 proxy.ts 同路径对齐），否则恢复探测被饿死
    releaseHalfOpenPending(cur.id);
    triedP.add(cur.id);
    for (const p of getPlatformsForModel(tgt, triedP)) { const k = getNextKey(p); if (k) { cur = p; curKey = k; break; } }
    if (!curKey) {
      // 全部平台无可用 Key：平台维度未知记 null（配置问题，不计入任何平台评分）
      try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: null, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 500, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "所有平台均无可用 API Key", ipAddress: clientInfo.ipAddress, userAgent: clientInfo.userAgent, db: dummyDb, env }); } catch {}
      // 告警：所有平台均无可用 Key（服务已不可用，最高优先级事件）
      void sendNotification("all_unavailable", "所有平台均无可用 API Key", `模型 ${requestedModel} 的请求无任何可用平台/Key，已返回 500`, { db: dummyDb, env });
      sendV1Error(res, config, 500, "所有平台均无可用 API Key", "server_error"); return;
    }
  }

  for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt++) {
    if (curKey) tried.add(curKey);
    triedP.add(cur.id);
    if (!curKey) {
      // 当前平台 Key 耗尽（同平台换 Key 失败）：计入该平台错误统计
      try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 500, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: `平台 "${cur.name}" 无可用 API Key`, ipAddress: clientInfo.ipAddress, userAgent: clientInfo.userAgent, db: dummyDb, env }); } catch {}
      sendV1Error(res, config, 500, `平台 "${cur.name}" 无可用 API Key`, "server_error"); return;
    }

    // 上游为 Anthropic 协议：请求体转回 /v1/messages 格式，URL 指向 /v1/messages，
    // 认证用 x-api-key + anthropic-version
    const upstreamIsAnthropic = cur.type === "anthropic";
    // chat↔responses 互转已移除，下游端点与上游端点原样透传
    const effectiveTargetApi = config.upstreamPath === "/responses" ? "responses" as const : "chat" as const;
    const effectiveUpstreamPath = config.upstreamPath;

    // 模板先作用于原始 OpenAI 请求体；Anthropic 分支随后转换——转换白名单会剥离
    // 模板中的 OpenAI 专属字段（stream_options/n/response_format 等），避免严格后端 422
    // Responses 与 Chat 分流：responses 仅命中 responses 模板，chat 仅命中 chat 模板
    let upstreamBody: Record<string, unknown> = { ...body, model: tgt };
    // multipart 请求体无法注入 JSON 模板字段（表单已定形），跳过模板应用
    if (!multipart) {
      try {
        const t = await loadTemplates(dummyDb, env);
        const templateType = effectiveTargetApi;
        const a = getApplicableTemplates(t, requestedModel, templateType);
        if (a.length > 0) upstreamBody = applyTemplates(upstreamBody, a);
      } catch {}
    }
    // 上游为 Anthropic 协议：请求体已在上方定义，此处无需重复定义
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
    // 流式判定以模板应用后的结果为准：模板可改写 stream 字段，若按原始请求体
    // 预判定，模板开流而原始请求未开流时上游返回 SSE 而代理走非流式 JSON 分支，
    // JSON.parse 失败后原样透传 SSE 文本 + application/json，客户端必解析失败
    // （与 Worker 全量版 effectiveIsStream 语义一致）
    const isStream = config.supportsStreaming !== false && upstreamBody.stream === true;
    // 流式请求注入 stream_options：仅当平台开启了注入开关时添加
    // 部分严格后端（Mistral 等 FastAPI/pydantic 校验）拒绝未知字段，返回 422 extra_forbidden
    // 用户可在平台管理页关闭此选项以兼容这类上游
    // Anthropic 协议上游同样拒绝未知字段，且 convertOpenAIRequest 已白名单剥离
    // Responses 端点不注入 stream_options（Responses 的流式 usage 由独立事件携带）
    if (isStream && cur.injectStreamOptions !== false && !upstreamIsAnthropic && effectiveUpstreamPath !== "/responses") upstreamBody.stream_options = { include_usage: true };

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
      : `${cur.baseUrl.replace(/\/+$/, "")}${effectiveUpstreamPath}`;
    const check = isSafeUpstreamUrl(cur.baseUrl);
    if (!check.safe) {
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 400, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: `上游 URL 不安全: ${check.reason}`, ipAddress: clientInfo.ipAddress, userAgent: clientInfo.userAgent, db: dummyDb, env }).catch(() => {});
      sendV1Error(res, config, 400, `上游 URL 不安全: ${check.reason}`, "invalid_request_error"); return;
    }

    // 注意：fetch resolve 后不立即 clearTimeout，signal 继续保护后续响应体读取；
    // 各分支（流式/非流式/错误）按需清理。
    let upRes: Response;
    const upstreamController = new AbortController();
    const upstreamTimeoutId = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
    const headers = new Headers({
      // multipart 请求：Content-Type 必须保留原始 boundary，否则上游无法解析表单
      "Content-Type": multipart ? multipart.contentType : "application/json",
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
    let proxy: Awaited<ReturnType<typeof getUpstreamProxyForKey>> | null = null;
    try {
      // 密钥级代理绑定优先：从当前使用的上游密钥对象中读取 proxyUrls/proxyStrict，
      // 有绑定时走 getUpstreamProxyForKey（优先使用密钥绑定代理），
      // 无绑定时由 getUpstreamProxyForKey 内部回退到平台级代理选择
      const keyObj = cur.apiKeyObjects?.find((o) => o.key === curKey);
      proxy = await getUpstreamProxyForKey(dummyDb, env, cur.id, keyObj?.proxyUrls, keyObj?.proxyStrict);
      if (proxy.error) {
        clearTimeout(upstreamTimeoutId);
        try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 502, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: proxy.error, ipAddress: clientInfo.ipAddress, userAgent: clientInfo.userAgent, db: dummyDb, env }); } catch {}
        sendV1Error(res, config, 502, proxy.error, "upstream_error"); return;
      }
      upRes = await fetch(url, { method: "POST", headers, body: multipart ? new Uint8Array(multipart.raw) : JSON.stringify(upstreamBody), signal: upstreamController.signal, redirect: "manual", ...(proxy.dispatcher ? { dispatcher: proxy.dispatcher } : {}) });
    }
    catch (e) {
      clearTimeout(upstreamTimeoutId);
      if (e instanceof DOMException && e.name === "AbortError") {
        // 上游请求超时（未收到响应头）：计入该平台错误统计并触发平台熔断
        // （此前只记日志不熔断，坏平台永远不会被降级，负载均衡反复撞上它——
        // 与 Worker 全量版 catch 分支行为对齐）
        void recordFailure(cur.id, dummyDb, env).catch(() => {});
        if (proxy?.url) recordProxyTraffic(proxy.url, 504);
        void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 504, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "上游请求超时", ipAddress: clientInfo.ipAddress, userAgent: clientInfo.userAgent, proxyUrl: proxy?.url ?? undefined, db: dummyDb, env }).catch(() => {});
        sendV1Error(res, config, 504, "上游请求超时", "timeout_error"); return;
      }
      // 网络层失败（非超时）：回标记当前代理，连续失败达阈值后轮询跳过；
      // 补落请求日志（status=502），否则真实失败不出现在 request_logs——
      // 统计可用率高估且与降权统计（recordProxyTraffic 记 errOther）口径矛盾；
      // 同时触发平台熔断（与 Worker 全量版一致）
      void recordFailure(cur.id, dummyDb, env).catch(() => {});
      if (proxy?.url) {
        recordProxyTraffic(proxy.url, 0);
        void markProxyFailure(dummyDb, env, proxy.url).catch(() => {});
      }
      // 直连路径同样补落请求日志并返回 502——此前仅代理路径有日志、直连路径
      // throw 冒泡到外层 catch 返回 500（request_logs 零记录、下游收到 500），
      // 与 Worker 全量版/lite 版「网络错误统一补记 + 502」对齐（status 记 502，
      // 后台按状态码筛选/统计口径一致；此前记 0 会从筛选与错误率聚合中丢失）
      void recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: cur.id,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status: 502,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: true,
        errorMessage: e instanceof Error ? e.message : String(e),
        ipAddress: clientInfo.ipAddress,
        userAgent: clientInfo.userAgent,
        proxyUrl: proxy?.url ?? undefined,
        db: dummyDb,
        env,
      }).catch(() => {});
      sendV1Error(res, config, 502, "上游请求失败（网络错误），请稍后重试", "upstream_error");
      return;
    }

    // ── 2xx 成功响应：正常处理（流式/非流式）──
    // 上游返回空响应（2xx + 空 body/空流）时 handleUpstreamResponsePages 返回哨兵，
    // 判定为无效，与 429/401/403 一样纳入重试（封禁当前 Key → 换 Key → 换平台）
    // 注意：redirect:"manual" 后 3xx 不再进入此分支，落入下方不可重试分支透传
    let isEmptyResponse = false;
    if (upRes.status >= 200 && upRes.status < 300) {
      const handled = await handleUpstreamResponsePages(upRes, cur, apiKey, requestedModel, config, isStream, startTime, env, est, anthropicInputEstimate, logTag, res, upstreamController, upstreamTimeoutId, proxy?.url ?? undefined, curKey, clientInfo);
      if (handled !== EMPTY_UPSTREAM_RESPONSE) return;
      isEmptyResponse = true;
    }

    // ── 5xx 等不可重试错误：真实透传状态码 + 熔断 + 错误日志 ──
    // 此前流式分支硬编码 200 透传任何非 429 状态，401/403/5xx 被伪装成成功，
    // 下游收到"200 + 空响应"，熔断器与 Key 封禁机制被完全架空。
    if (!isEmptyResponse && !RETRYABLE_UPSTREAM_STATUSES.has(upRes.status)) {
      // 上游 3xx（redirect:"manual" 不跟随）：重定向目标未经过 SSRF 校验，
      // 且 Location 头通常不会透传给下游，裸 3xx 对客户端无意义。这属于
      // 平台 baseUrl 配置错误而非平台故障，不计熔断失败，直接 502 明确提示
      if (upRes.status >= 300 && upRes.status < 400) {
        // 消费响应体释放连接（keep-alive 连接泄漏防护，与其他错误分支一致）
        void upRes.arrayBuffer().catch(() => {});
        clearTimeout(upstreamTimeoutId);
        // selectPlatform 可能已占用半开探测槽位；3xx 属配置错误不计熔断，
        // 但槽位必须归还，否则连续占用后平台恢复探测被饿死
        releaseHalfOpenPending(cur.id);
        if (proxy?.url) recordProxyTraffic(proxy.url, upRes.status);
        void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: upRes.status, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: `上游返回重定向（HTTP ${upRes.status}），请检查平台 baseUrl 配置`, ipAddress: clientInfo.ipAddress, userAgent: clientInfo.userAgent, proxyUrl: proxy?.url ?? undefined, db: dummyDb, env }).catch(() => {});
        sendV1Error(res, config, 502, "上游返回重定向，请检查平台 baseUrl 配置", "upstream_error"); return;
      }
      let errText = "";
      try { errText = await upRes.text(); } catch { /* 读取错误体失败（如 signal 超时） */ }
      clearTimeout(upstreamTimeoutId);
      try { await recordFailure(cur.id, dummyDb, env); } catch {}
      if (proxy?.url) recordProxyTraffic(proxy.url, upRes.status);
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: upRes.status, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: errText.substring(0, 1000), ipAddress: clientInfo.ipAddress, userAgent: clientInfo.userAgent, proxyUrl: proxy?.url ?? undefined, db: dummyDb, env }).catch(() => {});
      // 失败请求留痕：下游请求体 + 上游响应片段（截断 16KB），供日志页复现排查
      void saveDebugLog(dummyDb, env?.DB_TYPE, {
        model: requestedModel,
        platformId: cur.id,
        status: upRes.status,
        requestBody: JSON.stringify(rawBody),
        responseSnippet: errText,
        errorMessage: errText.substring(0, 1000),
      });
      res.setHeader("Content-Type", "application/json");
      if (config.protocol === "anthropic") {
        res.status(upRes.status).json(formatAnthropicError(upRes.status, sanitizeMessage(extractUpstreamErrorMessage(errText), upRes.status)));
      } else {
        res.status(upRes.status).send(sanitizeUpstreamError(errText, upRes.status));
      }
      return;
    }

    // ── 429/401/403/空响应：封禁当前 Key 并尝试切换 ──
    // 封禁与错误计数对每一轮（含最后一轮）都执行：此前仅封禁可重试的中间轮次，
    // 最后一次尝试失败时该 Key 逃过 5 分钟封禁与 errorCount 累计，
    // 自动禁用阈值（5 次）被系统性稀释（与 Worker 版 proxy.ts 对齐）
    // 该平台可能经 selectPlatform 占用了半开探测槽位；本路径不走
    // recordSuccess/recordFailure，必须显式归还（与 Worker 版同路径对齐）
    releaseHalfOpenPending(cur.id);
    await banKey(curKey, undefined, cur.id, env?.KV);
    // 平台级 429 冷却：429 是平台过载信号（区别于 Key 失效/越权），
    // 窗口内累计达阈值后平台进入冷却，调度层排除让上游限流窗口复位
    if (upRes.status === 429) recordPlatform429(cur.id);
    // 累加错误计数并持久化到数据库（429→+1, 401→+2, 其余→+1，达 5 次自动禁用）
    void recordKeyError(curKey, isEmptyResponse ? 502 : upRes.status, cur.id, dummyDb, env).catch(() => {});
    console.log(`${logTag} 上游 ${upRes.status}${isEmptyResponse ? "（空响应）" : ""} (平台: ${cur.name}, attempt: ${attempt + 1}/${MAX_UPSTREAM_RETRIES})，已封禁该 Key 5 分钟，尝试切换`);
    if (attempt < MAX_UPSTREAM_RETRIES) {
      // 本次尝试失败（429/401/403/空响应）独立记日志：被重试覆盖的错误平台也必须进入
      // 平台错误统计，否则评分只见最终成功平台、错误率被严重低估
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: isEmptyResponse ? 502 : upRes.status, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: isEmptyResponse ? "上游返回空响应（重试切换）" : `上游 ${upRes.status}（已封禁该 Key 并重试切换）`, ipAddress: clientInfo.ipAddress, userAgent: clientInfo.userAgent, proxyUrl: proxy?.url ?? undefined, db: dummyDb, env }).catch(() => {});
      if (proxy?.url) recordProxyTraffic(proxy.url, isEmptyResponse ? 502 : upRes.status);
      // 清理本次尝试的超时定时器，避免泄漏
      clearTimeout(upstreamTimeoutId);
      // 消费本次失败的响应体，避免 undici keep-alive 连接泄漏（空响应分支 body 已
      // 被 handleUpstreamResponsePages 消费过，此处 arrayBuffer 会 reject 被吞，安全）
      void upRes.arrayBuffer().catch(() => {});
      const nk = getRandomKeyExcept(cur, tried);
      if (nk) {
        // 指数退避 + 抖动（防重试风暴）：同平台换 Key 后立即重打同一过载平台只会
        // 加剧 429（上游限流窗口未复位），等待 250ms×2^attempt（上限 2s）+
        // 0~250ms 随机抖动错峰后再发下一轮；换平台路径不加（新平台可能不忙）
        const backoffMs = Math.min(250 * Math.pow(2, attempt), 2000) + Math.random() * 250;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        curKey = nk; continue;
      }
      const ops = getPlatformsForModel(tgt, triedP);
      if (ops.length > 0) {
        // 逐个尝试候选平台直到找到有可用 Key 的（与 Worker 版对齐：
        // 选中平台 Key 全部封禁时若直接放弃，会漏掉其余候选直接返回错误）
        const candidates = [...ops];
        let switched = false;
        while (candidates.length > 0 && !switched) {
          const nextPlatform = selectPlatform(candidates);
          if (!nextPlatform) break;
          const nextKey = getNextKey(nextPlatform);
          if (nextKey) {
            cur = nextPlatform; curKey = nextKey; switched = true;
          } else {
            // 该平台无可用 Key：剔除后继续尝试下一个候选。
            // 同时释放半开探测配额：选中但无 Key（Key 常处于封禁冷却，
            // 熔断 open 60 秒先解除）时若不释放，探测槽位被无 Key
            // 候选占满后该平台被排除，直到缓存重建才恢复
            releaseHalfOpenPending(nextPlatform.id);
            candidates.splice(candidates.indexOf(nextPlatform), 1);
          }
        }
        if (switched) continue;
      }
    }

    // 最后一次尝试或无处可切换：返回真实状态
    let errText = "";
    try { errText = await upRes.text(); } catch { /* 读取错误体失败（如 signal 超时） */ }
    clearTimeout(upstreamTimeoutId);
    try { await recordFailure(cur.id, dummyDb, env); } catch {}
    // 日志 status 记录实际返回下游的状态：空响应耗尽时下游收到 502，
    // 不再记上游的 200（此前记上游实际状态导致管理后台显示"成功"）
    void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: isEmptyResponse ? 502 : upRes.status, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: isEmptyResponse ? "上游返回空响应" : errText.substring(0, 1000), ipAddress: clientInfo.ipAddress, userAgent: clientInfo.userAgent, proxyUrl: proxy?.url ?? undefined, db: dummyDb, env }).catch(() => {});
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
      res.status(upRes.status).json(formatAnthropicError(upRes.status, sanitizeMessage(extractUpstreamErrorMessage(errText), upRes.status)));
    } else {
      res.status(upRes.status).send(sanitizeUpstreamError(errText, upRes.status));
    }
    return;
  }
}

async function handleUpstreamResponsePages(upRes: Response, platform: { id: string; name: string; type?: string }, apiKey: ApiKeyRecord, model: string, config: ProxyConfig, isStream: boolean, start: number, env: WorkerEnv & { KV?: KVNamespace; DB?: D1Database }, est: number, anthropicInputEstimate: number, tag: string, res: NextApiResponse, upstreamController: AbortController, upstreamTimeoutId: ReturnType<typeof setTimeout>, proxyUrl?: string, /** 本次请求使用的上游平台 Key 明文：流内密钥类错误（429/401/402/403）时封禁+计数；不传则跳过密钥级处理 */ platformKey?: string, /** 客户端 IP/UA（下游请求头提取）：所有日志分支落库来源信息 */ clientInfo?: { ipAddress?: string; userAgent?: string }): Promise<void | typeof EMPTY_UPSTREAM_RESPONSE> {
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
    let tt = 0, pt = 0, ct = 0, uc: number | null = null, buf = "";
    // 空完成检测：是否收到过有效输出内容（content/reasoning_content 非空）。
    // 上游 200 + 只有 [DONE]/空 data 的伪成功流不触发空流哨兵/流内 error/截断/
    // 空闲超时任何检测，此前被记成 200 成功（管理后台常见"200 + 0 tokens +
    // 数十秒首字延迟"即此场景）
    let sawContent = false;
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
                const d = JSON.parse(ol.slice(6)) as any;
                // chat↔responses 互转已移除，流式事件原样透传
                // 空完成检测：记录是否收到过有效输出内容（content/reasoning_content
                // 非空字符串；初始 role 占位 chunk 的 content 为空字符串不计）。
                // tool_calls 增量同样计入：纯工具调用流（无文本）不得误判空完成
                if (Array.isArray(d.choices)) {
                  for (const c of d.choices) {
                    const delta = c?.delta;
                    if (delta && ((typeof delta.content === "string" && delta.content.length > 0) || (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0))) {
                      sawContent = true;
                    }
                  }
                }
                // Responses API 流式：delta/output_text 等即视为有效内容（未转换时的兜底）
                if (typeof d.delta === "string" && d.delta.length > 0) sawContent = true;
                if (typeof d.output_text === "string" && d.output_text.length > 0) sawContent = true;
                if (Array.isArray(d.output) && d.output.length > 0) sawContent = true;
                if (d.response?.output) sawContent = true;
                if (d.type === "response.completed" || d.type === "response.done" || d.response?.status === "completed") sawDone = true;
                // 兼容 Chat 与 Responses 的 usage 形态
                const usageCandidate = (d as any).usage ?? (d as any).response?.usage ?? (d as any).response?.response?.usage;
                if (usageCandidate) { const ex = extractUsage(usageCandidate as Record<string, unknown>, est); tt = ex.totalTokens; pt = ex.promptTokens; ct = ex.completionTokens; uc = ex.upstreamCost; }
                if (d.error) { /* 与 Worker 版 resolveStreamErrorStatus 保持一致的语义：仅 400-599 整数视为错误码；code 缺失或为非数字字符串枚举（如 Azure "content_filter"）时兜底 502——否则流正常收尾会被记成 200 成功 */ const rawCode = d.error.code; const code = typeof rawCode === "number" ? rawCode : typeof rawCode === "string" ? parseInt(rawCode, 10) : NaN; if (!Number.isNaN(code) && Number.isInteger(code) && code >= 400 && code <= 599) { streamError = { code, message: String(d.error.message || "").substring(0, 1000) }; } else { streamError = { code: 502, message: String(d.error.message || "上游流内返回错误").substring(0, 1000) }; } }
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
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 504, tokens: 0, promptTokens: 0, completionTokens: 0, ttft, duration: Date.now() - start, isError: true, errorMessage: `上游响应空闲超时（${UPSTREAM_IDLE_TIMEOUT_MS / 1000} 秒无数据）`, ipAddress: clientInfo?.ipAddress, userAgent: clientInfo?.userAgent, proxyUrl, db: dummyDb, env }).catch(() => {});
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
        // 平台级 429 冷却：429 是平台过载信号（区别于 Key 失效/越权），
        // 与 HTTP 429 路径 recordPlatform429 对齐——流内 429 同样计入平台冷却
        if (streamError.code === 429) recordPlatform429(platform.id);
      }
      if (proxyUrl) recordProxyTraffic(proxyUrl, streamError.code);
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: streamError.code, tokens: 0, promptTokens: 0, completionTokens: 0, ttft, duration: Date.now() - start, isError: true, errorMessage: streamError.message, ipAddress: clientInfo?.ipAddress, userAgent: clientInfo?.userAgent, proxyUrl, db: dummyDb, env }).catch(() => {});
    } else if (!sawDone && !clientClosed) {
      // 上游流被截断：EOF 但未收到 [DONE]（如部分 zen-proxy 入口对长思考流 ~10s 截断）。
      // 客户端已收到 200 + 部分流无法改写状态码，但必须记失败并触发熔断，
      // 否则坏平台永远不会被降级，负载均衡会反复撞上它（此前一直记 200 成功）。
      // 客户端主动断开时不走此分支（流未读完是断开所致，非上游失败，不应触发熔断）
      try { await recordFailure(platform.id, dummyDb, env); } catch {}
      if (proxyUrl) recordProxyTraffic(proxyUrl, 502);
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 502, tokens: 0, promptTokens: 0, completionTokens: 0, ttft, duration: Date.now() - start, isError: true, errorMessage: "上游流未正常结束（EOF 但未收到 [DONE]），疑似上游截断", ipAddress: clientInfo?.ipAddress, userAgent: clientInfo?.userAgent, proxyUrl, db: dummyDb, env }).catch(() => {});
    } else if (sawDone && !sawContent && !clientClosed) {
      // 空完成：上游 200 + 流正常 [DONE] 收尾，但全程无有效内容（无 content/
      // reasoning_content）。免费模型排队超时或上游对代理 IP 降级时常返回这种
      // "伪成功"流——客户端收到 200 + 空完成（"empty completion"），日志此前
      // 记 200 成功且不触发熔断，坏平台评分不降、负载均衡反复撞上它。
      // 与截断同属上游失败：记失败日志（客户端已收到的 200 无法改写）；
      // 熔断软失败豁免——白名单平台（永不封禁语义）不因空完成被熔断，
      // 网络错误/5xx/截断/流内 error 等硬失败仍照常熔断。
      // 客户端主动断开时不走此分支（与截断分支一致：断开是下游原因，
      // 无法确认上游是否真的返回空流，不应触发熔断）
      if (!isPlatformWhitelisted(platform.id)) {
        try { await recordFailure(platform.id, dummyDb, env); } catch {}
      }
      if (proxyUrl) recordProxyTraffic(proxyUrl, 502);
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 502, tokens: 0, promptTokens: 0, completionTokens: 0, ttft, duration: Date.now() - start, isError: true, errorMessage: "上游返回空完成（200 + 流内无有效内容）", ipAddress: clientInfo?.ipAddress, userAgent: clientInfo?.userAgent, proxyUrl, db: dummyDb, env }).catch(() => {});
    } else {
      if (tt > 0) { try { await updateKeyUsage(apiKey.id, tt, dummyDb, env); } catch {} }
      if (proxyUrl) recordProxyTraffic(proxyUrl, 200);
      try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: tt, promptTokens: pt, completionTokens: ct, upstreamCost: uc, ttft, duration: Date.now() - start, isError: false, ipAddress: clientInfo?.ipAddress, userAgent: clientInfo?.userAgent, proxyUrl, db: dummyDb, env }); } catch {}
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
    void recordSuccess(platform.id, dummyDb, env).catch(() => {}); if (proxyUrl) recordProxyTraffic(proxyUrl, 200); void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - start, isError: false, ipAddress: clientInfo?.ipAddress, userAgent: clientInfo?.userAgent, proxyUrl, db: dummyDb, env }).catch(() => {});
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
  let rt = 0, rpt = 0, rct = 0, ruc: number | null = null;
  // 上游为 Anthropic 协议：先转成 OpenAI 内部格式（usage 提取与下游转换共用同一对象）；
  // 转换失败（非 JSON / 结构异常）时 openaiBody 为 null，交由下方 502 分支处理
  let openaiBody: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(body) as Record<string, unknown>;
    openaiBody = upstreamIsAnthropic ? convertAnthropicResponse(p, model) : p;
    if (openaiBody.usage) { const ex = extractUsage(openaiBody.usage as Record<string, unknown>, est); rt = ex.totalTokens; rpt = ex.promptTokens; rct = ex.completionTokens; ruc = ex.upstreamCost; }
  } catch {}
  res.setHeader("Content-Type", "application/json");
  if (config.protocol === "anthropic") {
    // OpenAI chat.completion → Anthropic message（回显下游请求的模型名）
    try {
      if (!openaiBody) throw new Error("unparseable");
      const converted = JSON.stringify(convertOpenAIResponse(openaiBody, model));
      // 转换成功后才记成功日志/用量，避免转换失败时留下"200 成功"的误导记录
      if (rt > 0) void updateKeyUsage(apiKey.id, rt, dummyDb, env).catch(() => {});
      if (proxyUrl) recordProxyTraffic(proxyUrl, 200);
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: rt, promptTokens: rpt, completionTokens: rct, upstreamCost: ruc, ttft: 0, duration: Date.now() - start, isError: false, ipAddress: clientInfo?.ipAddress, userAgent: clientInfo?.userAgent, proxyUrl, db: dummyDb, env }).catch(() => {});
      void recordSuccess(platform.id, dummyDb, env).catch(() => {});
      res.status(200).send(converted);
    } catch {
      try { await recordFailure(platform.id, dummyDb, env); } catch {}
      if (proxyUrl) recordProxyTraffic(proxyUrl, 502);
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 502, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - start, isError: true, errorMessage: "上游响应格式错误", ipAddress: clientInfo?.ipAddress, userAgent: clientInfo?.userAgent, proxyUrl, db: dummyDb, env }).catch(() => {});
      res.status(502).json(formatAnthropicError(502, "上游响应格式错误"));
    }
    return;
  }
  if (proxyUrl) recordProxyTraffic(proxyUrl, upRes.status);
  // 非流式直通成功记账：与流式分支（tt>0）和 anthropic 转换分支（rt>0）对齐，
  // 此前缺失导致 stream:false 请求绕过 tokenLimit/callUsed 扣减（计费漏洞）
  if (rt > 0) void updateKeyUsage(apiKey.id, rt, dummyDb, env).catch(() => {});
  void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: upRes.status, tokens: rt, promptTokens: rpt, completionTokens: rct, upstreamCost: ruc, ttft: 0, duration: Date.now() - start, isError: false, ipAddress: clientInfo?.ipAddress, userAgent: clientInfo?.userAgent, proxyUrl, db: dummyDb, env }).catch(() => {});
  void recordSuccess(platform.id, dummyDb, env).catch(() => {});
  // chat↔responses 互转已移除，非流式响应原样透传
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
      if ("error" in parseResult) { res.status(parseResult.statusCode ?? 400).json(formatAnthropicError(parseResult.statusCode ?? 400, parseResult.error)); return; }
      // count_tokens 是 JSON 端点：multipart 形态（"multipart" in parseResult）属客户端
      // 协议错误，按空体估算 0（不参与路由，无透传语义）
      res.status(200).json({ input_tokens: estimateInputTokens("body" in parseResult ? parseResult.body : {}) });
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
