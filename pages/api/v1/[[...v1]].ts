/**
 * /v1/* 代理路由 — Pages API 版本
 *
 * 非 CF 部署时由 Pages API 处理 /v1/* 代理请求。
 * CF 部署时此文件被构建门控脚本临时移除，由 Worker 处理。
 *
 * 核心逻辑复用 worker/src/ 下的业务模块，仅适配 Pages 运行时环境。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { validateApiKey, type ApiKeyRecord } from "../../../worker/src/auth";
import { routeRequest, refreshCache, getPlatformCache, getPlatformModelCache, freezeAutoModel, isAutoModelRequest, getPlatformsForModel } from "../../../worker/src/router";
import { getNextKey, getRandomKeyExcept, banKey } from "../../../worker/src/platform-keys";
import { recordSuccess, recordFailure } from "../../../worker/src/load-balancer";
import { extractUsage, updateKeyUsage, recordRequestLog } from "../../../worker/src/token";
import { extractForwardableHeaders } from "../../../worker/src/forward-headers";
import { loadTemplates, getApplicableTemplates, applyTemplates } from "../../../worker/src/request-templates";
import { checkPlatformRpm, checkPlatformTpm, checkApiKeyRpm, checkApiKeyTpm } from "@/lib/v1-rate-limit";
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

interface ProxyConfig { upstreamPath: string; supportsStreaming?: boolean; }

const PRIVATE_IP_PATTERNS = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^127\./, /^0\./];

function isSafeUpstreamUrl(urlStr: string): { safe: boolean; reason?: string } {
  let url: URL;
  try { url = new URL(urlStr); } catch { return { safe: false, reason: "URL 格式不合法" }; }
  if (!["http:", "https:"].includes(url.protocol)) return { safe: false, reason: "URL 协议必须是 http 或 https" };
  const h = url.hostname;
  if (h === "localhost" || h === "0.0.0.0" || h === "127.0.0.1" || PRIVATE_IP_PATTERNS.some(p => p.test(h)) || h === "[::1]" || h === "::1")
    return { safe: false, reason: "URL 不能指向内网或本地地址" };
  return { safe: true };
}

function sanitizeUpstreamError(text: string, status: number): string {
  try { const p = JSON.parse(text); const m = p?.error?.message || p?.message || p?.detail || ""; return JSON.stringify({ error: { message: String(m).substring(0, 500) || "上游服务返回错误", type: "upstream_error", upstream_status: status } }); }
  catch { return JSON.stringify({ error: { message: "上游服务返回未知错误", type: "upstream_error", upstream_status: status } }); }
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
    // 本地开发或非 CF 环境：回退 process.env
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
  if ("error" in parseResult) { res.status(400).json({ error: { message: parseResult.error, type: "invalid_request_error" } }); return; }
  const body = parseResult.body;

  const modelName = body.model as string | undefined;
  const requestedModel = modelName || "unknown";
  const route = modelName ? await routeRequest(modelName, dummyDb, env) : await routeRequest("__any__", dummyDb, env);
  if (!route) { res.status(500).json({ error: { message: "此模型不存在", type: "server_error" } }); return; }

  const pRpm = await checkPlatformRpm(route.platform.id, route.platform.rpmLimit);
  if (!pRpm.allowed) { res.status(429).json({ error: { message: "上游平台请求频率超限", type: "rate_limit_error", retry_after: Math.ceil((pRpm.resetAt - Date.now()) / 1000) } }); return; }
  const kRpm = await checkApiKeyRpm(apiKey.id, apiKey.rpmLimit);
  if (!kRpm.allowed) { res.status(429).json({ error: { message: "API Key 请求频率超限", type: "rate_limit_error", retry_after: Math.ceil((kRpm.resetAt - Date.now()) / 1000) } }); return; }
  const est = Math.max(1, Number(body.max_tokens || body.max_completion_tokens) || 1);
  const pTpm = await checkPlatformTpm(route.platform.id, route.platform.tpmLimit, est);
  if (!pTpm.allowed) { res.status(429).json({ error: { message: "上游平台 Token 速率超限", type: "rate_limit_error", retry_after: Math.ceil((pTpm.resetAt - Date.now()) / 1000) } }); return; }
  const kTpm = await checkApiKeyTpm(apiKey.id, apiKey.tpmLimit, est);
  if (!kTpm.allowed) { res.status(429).json({ error: { message: "API Key Token 速率超限", type: "rate_limit_error", retry_after: Math.ceil((kTpm.resetAt - Date.now()) / 1000) } }); return; }

  const MAX_UPSTREAM_RETRIES = 3;
  const isStream = config.supportsStreaming !== false && body.stream === true;
  let cur = route.platform; const tgt = route.targetModel;
  let curKey = getNextKey(cur);
  const tried = new Set<string>(), triedP = new Set<string>();

  if (!curKey) {
    triedP.add(cur.id);
    for (const p of getPlatformsForModel(tgt, triedP)) { const k = getNextKey(p); if (k) { cur = p; curKey = k; break; } }
    if (!curKey) { res.status(500).json({ error: { message: "所有平台均无可用 API Key", type: "server_error" } }); return; }
  }

  for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt++) {
    if (curKey) tried.add(curKey);
    triedP.add(cur.id);
    if (!curKey) { res.status(500).json({ error: { message: `平台 "${cur.name}" 无可用 API Key`, type: "server_error" } }); return; }

    let upstreamBody: Record<string, unknown> = { ...body, model: tgt };
    try { const t = await loadTemplates(dummyDb, env); const a = getApplicableTemplates(t, requestedModel); if (a.length > 0) upstreamBody = applyTemplates(upstreamBody, a); } catch {}
    if (isStream) upstreamBody.stream_options = { include_usage: true };

    const fwd: Record<string, string> = {};
    // NextApiRequest.headers 是 IncomingHttpHeaders（可能含 string[] 多值头），
    // 转成 Headers 以匹配 Worker 版 extractForwardableHeaders 签名
    const downstreamHeaders = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") downstreamHeaders.set(k, v);
    for (const [k, v] of Object.entries(extractForwardableHeaders(downstreamHeaders, cur.forwardHeaders)))
      if (/^[a-zA-Z0-9-]+$/.test(k)) fwd[k] = v;

    const url = `${cur.baseUrl.replace(/\/+$/, "")}${config.upstreamPath}`;
    const check = isSafeUpstreamUrl(cur.baseUrl);
    if (!check.safe) { res.status(400).json({ error: { message: `上游 URL 不安全: ${check.reason}`, type: "invalid_request_error" } }); return; }

    // 注意：fetch resolve 后不立即 clearTimeout，signal 继续保护后续响应体读取；
    // 各分支（流式/非流式/错误）按需清理。
    let upRes: Response;
    const upstreamController = new AbortController();
    const upstreamTimeoutId = setTimeout(() => upstreamController.abort(), UPSTREAM_TIMEOUT_MS);
    try { upRes = await fetch(url, { method: "POST", headers: new Headers({ "Content-Type": "application/json", Authorization: `Bearer ${curKey}`, ...fwd }), body: JSON.stringify(upstreamBody), signal: upstreamController.signal }); }
    catch (e) {
      clearTimeout(upstreamTimeoutId);
      if (e instanceof DOMException && e.name === "AbortError") { res.status(504).json({ error: { message: "上游请求超时", type: "timeout_error" } }); return; }
      throw e;
    }

    // ── 2xx 成功响应：正常处理（流式/非流式）──
    // 上游返回空响应（2xx + 空 body/空流）时 handleUpstreamResponsePages 返回哨兵，
    // 判定为无效，与 429/401/403 一样纳入重试（封禁当前 Key → 换 Key → 换平台）
    let isEmptyResponse = false;
    if (upRes.status < 400) {
      const handled = await handleUpstreamResponsePages(upRes, cur, apiKey, requestedModel, config, isStream, startTime, env, est, logTag, res, upstreamController, upstreamTimeoutId);
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
      try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: upRes.status, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: errText.substring(0, 1000), db: dummyDb, env }); } catch {}
      res.setHeader("Content-Type", "application/json"); res.status(upRes.status).send(sanitizeUpstreamError(errText, upRes.status)); return;
    }

    // ── 429/401/403/空响应：封禁当前 Key 并尝试切换 ──
    if (attempt < MAX_UPSTREAM_RETRIES) {
      await banKey(curKey, undefined, cur.id, env?.KV);
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
    // 空响应时日志 status 记上游实际状态（200），下游收到 502：有意保留上游事实，配合 isError + errorMessage 标记失败语义
    try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: upRes.status, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: isEmptyResponse ? "上游返回空响应" : errText.substring(0, 1000), db: dummyDb, env }); } catch {}
    if (isAutoModelRequest(requestedModel)) freezeAutoModel(requestedModel);
    // 空响应特判：绝不向下游透传空响应，返回 502 + 明确错误
    if (isEmptyResponse) {
      res.setHeader("Content-Type", "application/json");
      res.status(502).send(JSON.stringify({ error: { message: "上游返回空响应，请求已重试仍无内容", type: "upstream_error", upstream_status: upRes.status } }));
      return;
    }
    res.setHeader("Content-Type", "application/json"); res.status(upRes.status).send(sanitizeUpstreamError(errText, upRes.status)); return;
  }
}

async function handleUpstreamResponsePages(upRes: Response, platform: { id: string; name: string }, apiKey: ApiKeyRecord, model: string, config: ProxyConfig, isStream: boolean, start: number, env: WorkerEnv, est: number, tag: string, res: NextApiResponse, upstreamController: AbortController, upstreamTimeoutId: ReturnType<typeof setTimeout>): Promise<void | typeof EMPTY_UPSTREAM_RESPONSE> {
  if (isStream) {
    const s = upRes.body;
    if (!s) { clearTimeout(upstreamTimeoutId); try { await recordFailure(platform.id, dummyDb); } catch {} res.status(500).json({ error: { message: "上游未返回流式响应", type: "server_error" } }); return; }
    const r = s.getReader();
    // 先读第一块判断是否为空流：200 + 空 SSE 视为空响应，交由调用方重试；
    // 等待第一块仍受总超时（signal）保护
    let first: ReadableStreamReadResult<Uint8Array>;
    try { first = await r.read(); }
    catch {
      clearTimeout(upstreamTimeoutId);
      if (upstreamController.signal.aborted) { res.status(504).json({ error: { message: "上游响应读取超时", type: "timeout_error" } }); return; }
      res.status(500).json({ error: { message: "读取上游响应失败", type: "server_error" } }); return;
    }
    if (first.done) { clearTimeout(upstreamTimeoutId); r.releaseLock(); return EMPTY_UPSTREAM_RESPONSE; }
    // 总超时使命完成：流式响应允许长时间持续传输，改由空闲超时保护（无数据才切断）
    clearTimeout(upstreamTimeoutId);
    await recordSuccess(platform.id, dummyDb);
    res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.setHeader("Connection", "keep-alive");
    const d = new TextDecoder();
    let tt = 0, pt = 0, ct = 0, buf = "";
    let lastChunkAt = Date.now();
    let idleTimedOut = false;
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
          res.write(l + "\n");
          if (l.startsWith("data: ") && l !== "data: [DONE]") {
            try { const data = JSON.parse(l.slice(6)); if (data.usage) { const ex = extractUsage(data.usage, est); tt = ex.totalTokens; pt = ex.promptTokens; ct = ex.completionTokens; } } catch {}
          }
        }
        const { done, value } = await r.read();
        if (done) break;
        lastChunkAt = Date.now();
        pendingChunk = value;
      }
      if (buf) res.write(buf + "\n");
    } catch (e) {
      if (!idleTimedOut) console.error(`${tag} 流式错误:`, e);
    } finally {
      clearInterval(watchdog);
    }
    if (idleTimedOut) {
      try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - start, isError: true, errorMessage: `上游响应空闲超时（${UPSTREAM_IDLE_TIMEOUT_MS / 1000} 秒无数据）`, db: dummyDb, env }); } catch {}
    } else {
      if (tt > 0) { try { await updateKeyUsage(apiKey.id, tt, dummyDb, env); } catch {} }
      try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: tt, promptTokens: pt, completionTokens: ct, ttft: 0, duration: Date.now() - start, isError: false, db: dummyDb, env }); } catch {}
    }
    res.end(); return;
  }
  const ct = upRes.headers.get("content-type") || "";
  if (ct.includes("multipart/")) {
    let ab: ArrayBuffer;
    try { ab = await upRes.arrayBuffer(); } catch { clearTimeout(upstreamTimeoutId); if (upstreamController.signal.aborted) { res.status(504).json({ error: { message: "上游响应读取超时", type: "timeout_error" } }); return; } try { await recordFailure(platform.id, dummyDb); } catch {} res.status(500).json({ error: { message: "读取上游响应失败", type: "server_error" } }); return; }
    clearTimeout(upstreamTimeoutId);
    // 空响应：空 multipart 视为空响应，交由调用方重试
    if (ab.byteLength === 0) return EMPTY_UPSTREAM_RESPONSE;
    await recordSuccess(platform.id, dummyDb); try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - start, isError: false, db: dummyDb, env }); } catch {}
    res.setHeader("Content-Type", ct); res.status(200).send(Buffer.from(ab)); return;
  }
  let body: string;
  try { body = await upRes.text(); }
  catch {
    clearTimeout(upstreamTimeoutId);
    if (upstreamController.signal.aborted) { res.status(504).json({ error: { message: "上游响应读取超时", type: "timeout_error" } }); return; }
    await recordFailure(platform.id, dummyDb); res.status(500).json({ error: { message: "读取上游响应失败", type: "server_error" } }); return;
  }
  clearTimeout(upstreamTimeoutId);
  // 空响应：2xx 但响应体为空（上游返回空 body），判定无效交由调用方重试
  if (!body.trim()) return EMPTY_UPSTREAM_RESPONSE;
  let rt = 0, rpt = 0, rct = 0;
  try { const p = JSON.parse(body); if (p?.usage) { const ex = extractUsage(p.usage, est); rt = ex.totalTokens; rpt = ex.promptTokens; rct = ex.completionTokens; if (rt > 0) await updateKeyUsage(apiKey.id, rt, dummyDb, env); } } catch {}
  try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: upRes.status, tokens: rt, promptTokens: rpt, completionTokens: rct, ttft: 0, duration: Date.now() - start, isError: false, db: dummyDb, env }); } catch {}
  await recordSuccess(platform.id, dummyDb);
  res.setHeader("Content-Type", "application/json"); res.status(upRes.status).send(body);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  try {
    const v1 = (req.query.v1 as string[])?.join("/") || "";
    const full = `/v1/${v1}`;
    if (full === "/v1/models" && req.method === "GET") return await handleModelsList(res);
    if (full.startsWith("/v1/models/") && req.method === "GET") { return await handleModelDetail(decodeURIComponent(full.slice("/v1/models/".length)), res); }
    const cfg = getEndpointConfig(full);
    if (!cfg) { res.status(404).json({ error: { message: "不支持的 API 端点", type: "invalid_request_error" } }); return; }
    const env = await createPagesEnv();
    const auth = await validateApiKey(req.headers.authorization || null, dummyDb, env);
    if ("error" in auth) { const e = auth.error; res.status(e.status).json(await e.json()); return; }
    await proxyV1RequestPages(req, res, cfg, auth.apiKey);
  } catch (err) { console.error("[v1-proxy] 未捕获异常:", err); res.status(500).json({ error: { message: "服务器内部错误", type: "server_error" } }); }
}
