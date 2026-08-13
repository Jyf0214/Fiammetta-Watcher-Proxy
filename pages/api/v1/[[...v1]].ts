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
import { getNextKey, getRandomKeyExcept, banKey, recordKeyError } from "../../../worker/src/platform-keys";
import { recordSuccess, recordFailure } from "../../../worker/src/load-balancer";
import { extractUsage, updateKeyUsage, recordRequestLog } from "../../../worker/src/token";
import { extractForwardableHeaders } from "../../../worker/src/forward-headers";
import { loadTemplates, getApplicableTemplates, applyTemplates } from "../../../worker/src/request-templates";
import { checkPlatformRpm, checkPlatformTpm, checkApiKeyRpm, checkApiKeyTpm } from "@/lib/v1-rate-limit";
import { isSafeUpstreamUrl } from "@/lib/ssrf";
import { convertAnthropicRequest, convertOpenAIResponse, OpenAIToAnthropicStream, estimateInputTokens, formatAnthropicError, AnthropicRequestError } from "@/lib/anthropic";
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
let pagesEnvPromise: Promise<WorkerEnv & { KV?: KVNamespace }> | null = null;

async function resolvePagesEnv(): Promise<WorkerEnv & { KV?: KVNamespace }> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = getCloudflareContext() as { env: Record<string, any> };
    if (env.DB_TYPE) process.env.DB_TYPE = env.DB_TYPE;
    if (env.DATABASE_URL) process.env.DATABASE_URL = env.DATABASE_URL;
    if (env.TIDB_URL) process.env.TIDB_URL = env.TIDB_URL;
    if (env.PG_URL) process.env.PG_URL = env.PG_URL;
    if (env.MARIADB_URL) process.env.MARIADB_URL = env.MARIADB_URL;
    return {
      DB_TYPE: env.DB_TYPE,
      DATABASE_URL: env.DATABASE_URL,
      TIDB_URL: env.TIDB_URL,
      PG_URL: env.PG_URL,
      MARIADB_URL: env.MARIADB_URL,
      KV: env.KV,
    };
  } catch {
    // 本地开发或非 Cloudflare 环境：回退 process.env
    return {
      DB_TYPE: process.env.DB_TYPE,
      DATABASE_URL: process.env.DATABASE_URL,
      TIDB_URL: process.env.TIDB_URL,
      PG_URL: process.env.PG_URL,
      MARIADB_URL: process.env.MARIADB_URL,
    };
  }
}

function createPagesEnv(): Promise<WorkerEnv & { KV?: KVNamespace }> {
  if (!pagesEnvPromise) pagesEnvPromise = resolvePagesEnv();
  return pagesEnvPromise;
}
const dummyDb = {} as D1Database;

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
const RETRYABLE_UPSTREAM_STATUSES = new Set([429, 401, 403]);

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
    // 平台级限流反映平台过载/配额耗尽，计入该平台错误统计（Key 级限流是客户端行为，不记录避免污染平台评分）
    try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: route.platform.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 429, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "上游平台请求频率超限", db: dummyDb, env }); } catch {}
    sendV1Error(res, config, 429, "上游平台请求频率超限", "rate_limit_error", { retry_after: Math.ceil((pRpm.resetAt - Date.now()) / 1000) }); return;
  }
  const kRpm = await checkApiKeyRpm(apiKey.id, apiKey.rpmLimit);
  if (!kRpm.allowed) { sendV1Error(res, config, 429, "API Key 请求频率超限", "rate_limit_error", { retry_after: Math.ceil((kRpm.resetAt - Date.now()) / 1000) }); return; }
  const est = Math.max(1, Number(body.max_tokens || body.max_completion_tokens) || 1);
  // Anthropic 转换器的 message_start.usage.input_tokens：用转换前请求体的输入估算
  // （max_tokens 是输出上限，语义不符；仅限流 TPM 继续用 est）
  const anthropicInputEstimate = config.protocol === "anthropic" ? estimateInputTokens(rawBody) : est;
  const pTpm = await checkPlatformTpm(route.platform.id, route.platform.tpmLimit, est);
  if (!pTpm.allowed) {
    // 平台级 TPM 限流计入该平台错误统计（与平台 RPM 一致；Key 级不记录）
    try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: route.platform.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 429, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "上游平台 Token 速率超限", db: dummyDb, env }); } catch {}
    sendV1Error(res, config, 429, "上游平台 Token 速率超限", "rate_limit_error", { retry_after: Math.ceil((pTpm.resetAt - Date.now()) / 1000) }); return;
  }
  const kTpm = await checkApiKeyTpm(apiKey.id, apiKey.tpmLimit, est);
  if (!kTpm.allowed) { sendV1Error(res, config, 429, "API Key Token 速率超限", "rate_limit_error", { retry_after: Math.ceil((kTpm.resetAt - Date.now()) / 1000) }); return; }

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

    let upstreamBody: Record<string, unknown> = { ...body, model: tgt };
    try { const t = await loadTemplates(dummyDb, env); const a = getApplicableTemplates(t, requestedModel); if (a.length > 0) upstreamBody = applyTemplates(upstreamBody, a); } catch {}
    // 流式请求注入 stream_options：仅当平台开启了注入开关时添加
    // 部分严格后端（Mistral 等 FastAPI/pydantic 校验）拒绝未知字段，返回 422 extra_forbidden
    // 用户可在平台管理页关闭此选项以兼容这类上游
    if (isStream && cur.injectStreamOptions !== false) upstreamBody.stream_options = { include_usage: true };

    const fwd: Record<string, string> = {};
    // NextApiRequest.headers 是 IncomingHttpHeaders（可能含 string[] 多值头），
    // 转成 Headers 以匹配 Worker 版 extractForwardableHeaders 签名
    const downstreamHeaders = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") downstreamHeaders.set(k, v);
    for (const [k, v] of Object.entries(extractForwardableHeaders(downstreamHeaders, cur.forwardHeaders)))
      if (/^[a-zA-Z0-9-]+$/.test(k)) fwd[k] = v;

    const url = `${cur.baseUrl.replace(/\/+$/, "")}${config.upstreamPath}`;
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
    try { upRes = await fetch(url, { method: "POST", headers: new Headers({ "Content-Type": "application/json", Authorization: `Bearer ${curKey}`, ...fwd }), body: JSON.stringify(upstreamBody), signal: upstreamController.signal, redirect: "manual" }); }
    catch (e) {
      clearTimeout(upstreamTimeoutId);
      if (e instanceof DOMException && e.name === "AbortError") {
        // 上游请求超时（未收到响应头）：计入该平台错误统计
        void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 504, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: "上游请求超时", db: dummyDb, env }).catch(() => {});
        sendV1Error(res, config, 504, "上游请求超时", "timeout_error"); return;
      }
      throw e;
    }

    // ── 2xx 成功响应：正常处理（流式/非流式）──
    // 上游返回空响应（2xx + 空 body/空流）时 handleUpstreamResponsePages 返回哨兵，
    // 判定为无效，与 429/401/403 一样纳入重试（封禁当前 Key → 换 Key → 换平台）
    // 注意：redirect:"manual" 后 3xx 不再进入此分支，落入下方不可重试分支透传
    let isEmptyResponse = false;
    if (upRes.status >= 200 && upRes.status < 300) {
      const handled = await handleUpstreamResponsePages(upRes, cur, apiKey, requestedModel, config, isStream, startTime, env, est, anthropicInputEstimate, logTag, res, upstreamController, upstreamTimeoutId);
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
      try { await recordFailure(cur.id, dummyDb); } catch {}
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: upRes.status, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: errText.substring(0, 1000), db: dummyDb, env }).catch(() => {});
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
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: isEmptyResponse ? 502 : upRes.status, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: isEmptyResponse ? "上游返回空响应（重试切换）" : `上游 ${upRes.status}（已封禁该 Key 并重试切换）`, db: dummyDb, env }).catch(() => {});
      await banKey(curKey, undefined, cur.id, env?.KV);
      // 累加错误计数并持久化到数据库（429→+1, 401→+2, 其余→+1，达 5 次自动禁用）
      void recordKeyError(curKey, isEmptyResponse ? 502 : upRes.status, cur.id, dummyDb, env).catch(() => {});
      console.log(`${logTag} 上游 ${upRes.status}${isEmptyResponse ? "（空响应）" : ""} (平台: ${cur.name}, attempt: ${attempt + 1}/${MAX_UPSTREAM_RETRIES})，已封禁该 Key 5 分钟，尝试切换`);
      // 清理本次尝试的超时定时器，避免泄漏
      clearTimeout(upstreamTimeoutId);
      const nk = getRandomKeyExcept(cur, tried);
      if (nk) { curKey = nk; continue; }
      const ops = getPlatformsForModel(tgt, triedP);
      if (ops.length > 0) { cur = ops[Math.floor(Math.random() * ops.length)]; curKey = getNextKey(cur); continue; }
    }

    // 最后一次尝试或无处可切换：返回真实状态
    let errText = "";
    try { errText = await upRes.text(); } catch { /* 读取错误体失败（如 signal 超时） */ }
    clearTimeout(upstreamTimeoutId);
    try { await recordFailure(cur.id, dummyDb); } catch {}
    // 日志 status 记录实际返回下游的状态：空响应耗尽时下游收到 502，
    // 不再记上游的 200（此前记上游实际状态导致管理后台显示"成功"）
    void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: isEmptyResponse ? 502 : upRes.status, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: isEmptyResponse ? "上游返回空响应" : errText.substring(0, 1000), db: dummyDb, env }).catch(() => {});
    if (isAutoModelRequest(requestedModel)) freezeAutoModel(requestedModel);
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

async function handleUpstreamResponsePages(upRes: Response, platform: { id: string; name: string }, apiKey: ApiKeyRecord, model: string, config: ProxyConfig, isStream: boolean, start: number, env: WorkerEnv, est: number, anthropicInputEstimate: number, tag: string, res: NextApiResponse, upstreamController: AbortController, upstreamTimeoutId: ReturnType<typeof setTimeout>): Promise<void | typeof EMPTY_UPSTREAM_RESPONSE> {
  if (isStream) {
    const s = upRes.body;
    if (!s) { clearTimeout(upstreamTimeoutId); try { await recordFailure(platform.id, dummyDb); } catch {} sendV1Error(res, config, 500, "上游未返回流式响应", "server_error"); return; }
    const r = s.getReader();
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
    void recordSuccess(platform.id, dummyDb).catch(() => {});
    // no-transform：阻止 next start（Node 服务器）内置 gzip 压缩流式响应。
    // compression 中间件会把每个 write 导入 zlib 流，输出攒够 16KB 才下发，
    // 导致思考内容被整体缓冲、首字节随思考延伸而推迟，且大响应尾部有截断风险。
    res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache, no-transform"); res.setHeader("Connection", "keep-alive");
    const d = new TextDecoder();
    let tt = 0, pt = 0, ct = 0, buf = "";
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
        if (idleTimedOut) break;
        buf += d.decode(pendingChunk, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const l of lines) {
          if (l === "data: [DONE]") { sawDone = true; if (!streamer) res.write(l + "\n"); continue; }
          if (!l.startsWith("data: ")) {
            // 非 data 行（空行分隔符等）：OpenAI 分支原样透传，Anthropic 分支由转换器生成格式
            if (!streamer) res.write(l + "\n");
            continue;
          }
          try {
            const data = JSON.parse(l.slice(6));
            if (data.usage) { const ex = extractUsage(data.usage, est); tt = ex.totalTokens; pt = ex.promptTokens; ct = ex.completionTokens; }
            if (data.error) { /* 与 Worker 版 resolveStreamErrorStatus 保持一致的语义：仅 400-599 整数视为错误码（浮点等病态值会让 Prisma Int 校验失败、日志整条丢失） */ const rawCode = data.error.code; const code = typeof rawCode === "number" ? rawCode : typeof rawCode === "string" ? parseInt(rawCode, 10) : NaN; if (!Number.isNaN(code) && Number.isInteger(code) && code >= 400 && code <= 599) { streamError = { code, message: String(data.error.message || "").substring(0, 1000) }; } }
            if (streamer) {
              // 纯 usage chunk（无 choices 键）也可能携带 output_tokens，不能过滤掉
              if (data.choices || data.usage) res.write(streamer.feedChunk(data));
            } else {
              res.write(l + "\n");
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
          res.write(`event: error\ndata: ${JSON.stringify(formatAnthropicError(code, message))}\n\n`);
        } else {
          // Anthropic 收尾：关闭内容块 → message_delta（stop_reason/usage）→ message_stop
          res.write(streamer.finish());
        }
      } else if (buf) {
        res.write(buf + "\n");
      }
    } catch (e) {
      if (!idleTimedOut) console.error(`${tag} 流式错误:`, e);
    } finally {
      clearInterval(watchdog);
    }
    if (idleTimedOut) {
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 504, tokens: 0, promptTokens: 0, completionTokens: 0, ttft, duration: Date.now() - start, isError: true, errorMessage: `上游响应空闲超时（${UPSTREAM_IDLE_TIMEOUT_MS / 1000} 秒无数据）`, db: dummyDb, env }).catch(() => {});
    } else if (streamError) {
      // 流内 error：按错误码记录失败日志（不计 Key 用量），下游实际收到的是 200 + error 流
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: streamError.code, tokens: 0, promptTokens: 0, completionTokens: 0, ttft, duration: Date.now() - start, isError: true, errorMessage: streamError.message, db: dummyDb, env }).catch(() => {});
    } else if (!sawDone) {
      // 上游流被截断：EOF 但未收到 [DONE]（如部分 zen-proxy 入口对长思考流 ~10s 截断）。
      // 客户端已收到 200 + 部分流无法改写状态码，但必须记失败并触发熔断，
      // 否则坏平台永远不会被降级，负载均衡会反复撞上它（此前一直记 200 成功）。
      try { await recordFailure(platform.id, dummyDb); } catch {}
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 502, tokens: 0, promptTokens: 0, completionTokens: 0, ttft, duration: Date.now() - start, isError: true, errorMessage: "上游流未正常结束（EOF 但未收到 [DONE]），疑似上游截断", db: dummyDb, env }).catch(() => {});
    } else {
      if (tt > 0) { try { await updateKeyUsage(apiKey.id, tt, dummyDb, env); } catch {} }
      try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: tt, promptTokens: pt, completionTokens: ct, ttft, duration: Date.now() - start, isError: false, db: dummyDb, env }); } catch {}
    }
    res.end(); return;
  }
  const ct = upRes.headers.get("content-type") || "";
  if (ct.includes("multipart/")) {
    let ab: ArrayBuffer;
    try { ab = await upRes.arrayBuffer(); } catch { clearTimeout(upstreamTimeoutId); if (upstreamController.signal.aborted) { sendV1Error(res, config, 504, "上游响应读取超时", "timeout_error"); return; } try { await recordFailure(platform.id, dummyDb); } catch {} sendV1Error(res, config, 500, "读取上游响应失败", "server_error"); return; }
    clearTimeout(upstreamTimeoutId);
    // 空响应：空 multipart 视为空响应，交由调用方重试
    if (ab.byteLength === 0) return EMPTY_UPSTREAM_RESPONSE;
    // 不阻塞响应：写库后置为 fire-and-forget（与流式分支一致）
    void recordSuccess(platform.id, dummyDb).catch(() => {}); void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - start, isError: false, db: dummyDb, env }).catch(() => {});
    res.setHeader("Content-Type", ct); res.status(200).send(Buffer.from(ab)); return;
  }
  let body: string;
  try { body = await upRes.text(); }
  catch {
    clearTimeout(upstreamTimeoutId);
    if (upstreamController.signal.aborted) { sendV1Error(res, config, 504, "上游响应读取超时", "timeout_error"); return; }
    await recordFailure(platform.id, dummyDb); sendV1Error(res, config, 500, "读取上游响应失败", "server_error"); return;
  }
  clearTimeout(upstreamTimeoutId);
  // 空响应：2xx 但响应体为空（上游返回空 body），判定无效交由调用方重试
  if (!body.trim()) return EMPTY_UPSTREAM_RESPONSE;
  let rt = 0, rpt = 0, rct = 0;
  try { const p = JSON.parse(body); if (p?.usage) { const ex = extractUsage(p.usage, est); rt = ex.totalTokens; rpt = ex.promptTokens; rct = ex.completionTokens; if (rt > 0) void updateKeyUsage(apiKey.id, rt, dummyDb, env).catch(() => {}); } } catch {}
  res.setHeader("Content-Type", "application/json");
  if (config.protocol === "anthropic") {
    // OpenAI chat.completion → Anthropic message（回显下游请求的模型名）
    try {
      const converted = JSON.stringify(convertOpenAIResponse(JSON.parse(body) as Record<string, unknown>, model));
      // 转换成功后才记成功日志/用量，避免转换失败时留下"200 成功"的误导记录
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: rt, promptTokens: rpt, completionTokens: rct, ttft: 0, duration: Date.now() - start, isError: false, db: dummyDb, env }).catch(() => {});
      void recordSuccess(platform.id, dummyDb).catch(() => {});
      res.status(200).send(converted);
    } catch {
      try { await recordFailure(platform.id, dummyDb); } catch {}
      void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 502, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - start, isError: true, errorMessage: "上游响应格式错误", db: dummyDb, env }).catch(() => {});
      res.status(502).json(formatAnthropicError(502, "上游响应格式错误"));
    }
    return;
  }
  void recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: upRes.status, tokens: rt, promptTokens: rpt, completionTokens: rct, ttft: 0, duration: Date.now() - start, isError: false, db: dummyDb, env }).catch(() => {});
  void recordSuccess(platform.id, dummyDb).catch(() => {});
  res.status(upRes.status).send(body);
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
    if (full.startsWith("/v1/models/") && req.method === "GET") { return await handleModelDetail(decodeURIComponent(full.slice("/v1/models/".length)), res); }
    await proxyV1RequestPages(req, res, cfg, auth.apiKey);
  } catch (err) {
    console.error("[v1-proxy] 未捕获异常:", err);
    if (cfg?.protocol === "anthropic") { res.status(500).json(formatAnthropicError(500, "服务器内部错误")); return; }
    res.status(500).json({ error: { message: "服务器内部错误", type: "server_error" } });
  }
}
