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

function createPagesEnv(): WorkerEnv { return { DB_TYPE: process.env.DB_TYPE }; }
const dummyDb = {} as D1Database;

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
  const env = createPagesEnv();
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
  const env = createPagesEnv();
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
  const env = createPagesEnv();
  const logTag = `[v1-proxy:${config.upstreamPath}]`;

  const parseResult = await parseRequestBody<Record<string, unknown>>(req);
  if ("error" in parseResult) { res.status(400).json({ error: { message: parseResult.error, type: "invalid_request_error" } }); return; }
  const body = parseResult.body;

  const modelName = body.model as string | undefined;
  const requestedModel = modelName || "unknown";
  const route = modelName ? await routeRequest(modelName, dummyDb, env) : await routeRequest("__any__", dummyDb, env);
  if (!route) { res.status(503).json({ error: { message: "没有可用的上游平台", type: "server_error" } }); return; }

  const pRpm = await checkPlatformRpm(route.platform.id, route.platform.rpmLimit);
  if (!pRpm.allowed) { res.status(429).json({ error: { message: "上游平台请求频率超限", type: "rate_limit_error", retry_after: Math.ceil((pRpm.resetAt - Date.now()) / 1000) } }); return; }
  const kRpm = await checkApiKeyRpm(apiKey.id, apiKey.rpmLimit);
  if (!kRpm.allowed) { res.status(429).json({ error: { message: "API Key 请求频率超限", type: "rate_limit_error", retry_after: Math.ceil((kRpm.resetAt - Date.now()) / 1000) } }); return; }
  const est = Math.max(1, Number(body.max_tokens || body.max_completion_tokens) || 1);
  const pTpm = await checkPlatformTpm(route.platform.id, route.platform.tpmLimit, est);
  if (!pTpm.allowed) { res.status(429).json({ error: { message: "上游平台 Token 速率超限", type: "rate_limit_error", retry_after: Math.ceil((pTpm.resetAt - Date.now()) / 1000) } }); return; }
  const kTpm = await checkApiKeyTpm(apiKey.id, apiKey.tpmLimit, est);
  if (!kTpm.allowed) { res.status(429).json({ error: { message: "API Key Token 速率超限", type: "rate_limit_error", retry_after: Math.ceil((kTpm.resetAt - Date.now()) / 1000) } }); return; }

  const MAX_429 = 3;
  const isStream = config.supportsStreaming !== false && body.stream === true;
  let cur = route.platform; const tgt = route.targetModel;
  let curKey = getNextKey(cur);
  const tried = new Set<string>(), triedP = new Set<string>();

  if (!curKey) {
    triedP.add(cur.id);
    for (const p of getPlatformsForModel(tgt, triedP)) { const k = getNextKey(p); if (k) { cur = p; curKey = k; break; } }
    if (!curKey) { res.status(500).json({ error: { message: "所有平台均无可用 API Key", type: "server_error" } }); return; }
  }

  for (let attempt = 0; attempt <= MAX_429; attempt++) {
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

    let upRes: Response;
    try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 120_000); upRes = await fetch(url, { method: "POST", headers: new Headers({ "Content-Type": "application/json", Authorization: `Bearer ${curKey}`, ...fwd }), body: JSON.stringify(upstreamBody), signal: c.signal }); clearTimeout(t); }
    catch (e) { if (e instanceof DOMException && e.name === "AbortError") { res.status(504).json({ error: { message: "上游请求超时", type: "timeout_error" } }); return; } throw e; }

    if (upRes.status !== 429) { await handleUpstreamResponsePages(upRes, cur, apiKey, requestedModel, config, isStream, startTime, env, est, logTag, res); return; }

    if (attempt < MAX_429) {
      banKey(curKey);
      const nk = getRandomKeyExcept(cur, tried);
      if (nk) { curKey = nk; continue; }
      const ops = getPlatformsForModel(tgt, triedP);
      if (ops.length > 0) { cur = ops[Math.floor(Math.random() * ops.length)]; curKey = getNextKey(cur); continue; }
    }

    const errText = await upRes.text();
    try { await recordFailure(cur.id, dummyDb); } catch {}
    try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: cur.id, model: requestedModel, endpoint: config.upstreamPath, method: "POST", status: 429, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - startTime, isError: true, errorMessage: errText.substring(0, 1000), db: dummyDb, env }); } catch {}
    if (isAutoModelRequest(requestedModel)) freezeAutoModel(requestedModel);
    res.setHeader("Content-Type", "application/json"); res.status(429).send(sanitizeUpstreamError(errText, 429)); return;
  }
}

async function handleUpstreamResponsePages(upRes: Response, platform: { id: string; name: string }, apiKey: ApiKeyRecord, model: string, config: ProxyConfig, isStream: boolean, start: number, env: WorkerEnv, est: number, tag: string, res: NextApiResponse): Promise<void> {
  if (isStream) {
    const s = upRes.body;
    if (!s) { try { await recordFailure(platform.id, dummyDb); } catch {} res.status(500).json({ error: { message: "上游未返回流式响应", type: "server_error" } }); return; }
    await recordSuccess(platform.id, dummyDb);
    res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-cache"); res.setHeader("Connection", "keep-alive");
    const r = s.getReader(), d = new TextDecoder();
    let tt = 0, pt = 0, ct = 0, buf = "";
    try { while (true) { const { done, value } = await r.read(); if (done) break; buf += d.decode(value, { stream: true }); const lines = buf.split("\n"); buf = lines.pop() || ""; for (const l of lines) { res.write(l + "\n"); if (l.startsWith("data: ") && l !== "data: [DONE]") { try { const data = JSON.parse(l.slice(6)); if (data.usage) { const ex = extractUsage(data.usage, est); tt = ex.totalTokens; pt = ex.promptTokens; ct = ex.completionTokens; } } catch {} } } } if (buf) res.write(buf + "\n"); } catch (e) { console.error(`${tag} 流式错误:`, e); }
    if (tt > 0) { try { await updateKeyUsage(apiKey.id, tt, dummyDb, env); } catch {} }
    try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: tt, promptTokens: pt, completionTokens: ct, ttft: 0, duration: Date.now() - start, isError: false, db: dummyDb, env }); } catch {}
    res.end(); return;
  }
  const ct = upRes.headers.get("content-type") || "";
  if (ct.includes("multipart/")) { await recordSuccess(platform.id, dummyDb); try { await recordRequestLog({ keyId: apiKey.id, keyName: apiKey.name, platformId: platform.id, model, endpoint: config.upstreamPath, method: "POST", status: 200, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, duration: Date.now() - start, isError: false, db: dummyDb, env }); } catch {} const ab = await upRes.arrayBuffer(); res.setHeader("Content-Type", ct); res.status(200).send(Buffer.from(ab)); return; }
  let body: string; try { body = await upRes.text(); } catch { await recordFailure(platform.id, dummyDb); res.status(500).json({ error: { message: "读取上游响应失败", type: "server_error" } }); return; }
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
    const auth = await validateApiKey(req.headers.authorization || null, dummyDb, createPagesEnv());
    if ("error" in auth) { const e = auth.error; res.status(e.status).json(await e.json()); return; }
    await proxyV1RequestPages(req, res, cfg, auth.apiKey);
  } catch (err) { console.error("[v1-proxy] 未捕获异常:", err); res.status(500).json({ error: { message: "服务器内部错误", type: "server_error" } }); }
}
