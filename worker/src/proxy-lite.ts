/**
 * Lite 版上游代理 — 单次尝试，不重试、不熔断平台
 *
 * VERSION=lite 时构建使用，以最小化 CPU 运行时间：
 * - 单次上游请求：429/401/403/5xx/空响应一律真实透传，不换 Key 不换平台
 * - 密钥类错误（429/401/402/403）封禁 Key 并累加错误计数（达 5 次自动禁用，
 *   与全量版一致；HTTP 透传与流内 error 两条路径均执行）
 * - 只写请求日志（request_logs）：不含熔断器写入、Key 用量更新、速率限制
 * - 流式响应仍做 usage/TTFT 提取（日志质量与全量版一致，供管理后台展示）
 * - 不应用请求模板、不检查平台/Key 级 RPM/TPM
 */

import { routeRequestLite } from "./router-lite";
import { getNextKey, recordKeyError, banKey } from "./platform-keys";
import { recordRequestLog, extractUsage, resolveStreamErrorStatus, extractClientInfo } from "./token";
import { recordPlatform429 } from "./load-balancer";
import { sendNotification } from "@/lib/notifier";
import { withIdleTimeout } from "./stream-guard";
import { extractForwardableHeaders, parseExtraHeaders } from "./forward-headers";
import { buildProxyError } from "./proxy-core/error-response";
import { isSafeUpstreamUrl } from "@/lib/ssrf";
import {
  convertOpenAIResponse,
  OpenAIToAnthropicStream,
  formatAnthropicError,
  AnthropicRequestError,
  estimateInputTokens,
  convertOpenAIRequest,
  OpenAIRequestError,
  convertAnthropicResponse,
  AnthropicToOpenAIStream,
} from "@/lib/anthropic";
import type { ProxyConfig } from "./endpoints";
import type { ApiKeyRecord } from "./auth";
import type { WorkerEnv } from "./config";

// ==================== 上游错误脱敏 ====================

/** 提取上游错误体中的可读消息 */
function extractUpstreamErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text);
    // parsed?.detail 可能是数组（FastAPI 标准格式）或对象，不能直接 String()，否则变成 "[object Object]"
    const raw = parsed?.error?.message || parsed?.message || parsed?.detail || "";
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

/**
 * 脱敏上游错误响应，仅提取错误消息
 */
function sanitizeUpstreamError(errorText: string, upstreamStatus: number): string {
  return JSON.stringify({
    error: {
      message: sanitizeMessage(extractUpstreamErrorMessage(errorText), upstreamStatus),
      type: "upstream_error",
      upstream_status: upstreamStatus,
    },
  });
}

/**
 * 按协议构造错误响应：委托共享层 buildProxyError（proxy-core/error-response，
 * 三端错误体构造的唯一实现）。anthropic 用 {type:"error",error:{type,message}}，
 * openai 保持 {error:{message,type}}。状态码两边保持一致。
 *
 * protocol 判定与原内联分支语义一致：仅 "anthropic" 走 anthropic 分支，
 * 其余（含缺省 undefined）走 openai 分支。lite 全部调用点均为 4 参调用
 * （无 extra），故不传 retryAfterSeconds；共享层契约亦不支持任意 extra 键
 * 展开，第 5 参仅为保持既有签名占位（下划线前缀表未使用）。
 */
function liteErrorResponse(
  cfg: ProxyConfig,
  status: number,
  message: string,
  type: string,
  _extra?: Record<string, unknown>
): Response {
  const payload = buildProxyError({
    protocol: cfg.protocol === "anthropic" ? "anthropic" : "openai",
    status,
    message,
    type,
  });
  return new Response(payload.body, {
    status: payload.status,
    headers: { "Content-Type": payload.contentType },
  });
}

// ==================== 配置常量（与全量版 proxy.ts 保持一致） ====================

/** 上游请求总超时（等待响应头 + 非流式响应体） */
const UPSTREAM_TIMEOUT_MS = 120_000;

/** 流式响应空闲超时：距上次收到数据超过该时长即切断 */
const UPSTREAM_IDLE_TIMEOUT_MS = 120_000;

/** 请求体大小上限 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * token 数预估值上限（与全量版 proxy.ts / Pages 版同值）：
 * 上游未返回 usage 时的兜底记账依据，客户端可能传极大 max_tokens，钳制防污染
 */
const MAX_ESTIMATED_TOKENS = 8192;

/**
 * 透传白名单禁止项（大小写不敏感）：认证/请求语义类头不得由下游客户端透传覆盖。
 * 与全量版 proxy.ts 同集合——lite 部署若允许 authorization/x-api-key 等透传覆盖，
 * 下游客户端可替换平台密钥（401 封禁循环 / BYOK 绕过计费），content-length 等
 * 则与重写后的请求体不符导致上游解析错乱。管理后台表单同样禁止（双端防护，
 * 代理层为最终防线）。
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
  // 下游伪造 x-forwarded-* 可污染日志 IP 与可信代理判定，统一禁止透传
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "cf-connecting-ip",
  "eo-client-ip",
  "eo-connecting-ip",
  "x-vercel-forwarded-for",
]);

// ==================== 请求体解析 ====================

/** multipart/form-data 请求体解析结果：仅提取 model 字段用于路由，原始字节转发时透传 */
type MultipartBody = { model: string | null; raw: Uint8Array; contentType: string };

async function parseRequestBody<T>(
  request: Request
): Promise<{ body: T } | { multipart: MultipartBody } | { error: Response }> {
  if (Number(request.headers.get("content-length") || "0") > MAX_BODY_BYTES) {
    return {
      error: Response.json(
        { error: { message: "请求体过大", type: "invalid_request_error" } },
        { status: 413 }
      ),
    };
  }

  const contentType = request.headers.get("content-type") || "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    // multipart（images/edits、audio/transcriptions 等）：此前只做 JSON.parse，
    // 标准客户端必然发送 multipart 导致固定 400「请求体格式错误」，端点形同虚设；
    // 现读取原始字节透传上游，formData 仅用于提取 model 路由
    let raw: Uint8Array;
    try {
      raw = new Uint8Array(await request.arrayBuffer());
    } catch {
      return {
        error: Response.json(
          { error: { message: "读取请求体失败", type: "invalid_request_error" } },
          { status: 400 }
        ),
      };
    }

    // Content-Length 预检之外的按字节兜底（与全量版 proxy.ts 一致）
    if (raw.length > MAX_BODY_BYTES) {
      return {
        error: Response.json(
          { error: { message: "请求体过大", type: "invalid_request_error" } },
          { status: 413 }
        ),
      };
    }

    let model: string | null = null;
    try {
      const fd = await new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: raw,
      }).formData();
      const m = fd.get("model");
      model = typeof m === "string" && m.length > 0 ? m : null;
    } catch {
      // 非标准 multipart（boundary 畸形等）：model 留 null，调用方按缺 model 400
    }
    return { multipart: { model, raw, contentType } };
  }

  let rawText: string;
  try {
    rawText = await request.text();
  } catch {
    return {
      error: Response.json(
        { error: { message: "读取请求体失败", type: "invalid_request_error" } },
        { status: 400 }
      ),
    };
  }

  // Content-Length 预检之外的按字节兜底（与全量版 proxy.ts 一致）：chunked 编码
  // （无 Content-Length 头）时任意大的请求体会被整体读入内存，无上限保护
  if (rawText.length > MAX_BODY_BYTES) {
    return {
      error: Response.json(
        { error: { message: "请求体过大", type: "invalid_request_error" } },
        { status: 413 }
      ),
    };
  }

  // 空 body 不特判放行：JSON.parse("") 抛错走下方 catch → 400「请求体格式错误」，
  // 与全量版 proxy.ts parseRequestBody 行为一致（此前空 body 放行走 __any__ 路由
  // 发起真实上游请求浪费配额，两版行为分叉）
  try {
    return { body: JSON.parse(rawText) as T };
  } catch {
    return {
      error: Response.json(
        { error: { message: "请求体格式错误", type: "invalid_request_error" } },
        { status: 400 }
      ),
    };
  }
}

// ==================== Lite 流式 Usage 转换器 ====================

/**
 * 流式响应 usage/TTFT 提取（lite 专用）
 *
 * 与全量版 createUsageTransformer 的差异：flush 只写 request_logs，
 * 不触发熔断器记录（truncated 不 recordFailure）、不更新 Key 用量。
 */
function createLiteUsageTransformer(params: {
  keyId: string;
  keyName: string | null;
  platformId: string;
  model: string;
  startTime: number;
  /** 上游平台 Key 明文：流内密钥类错误（429/401/402/403）时封禁+计数；不传则跳过密钥级处理 */
  key?: string;
  /** 上游真实端点路径（如 /chat/completions）：请求日志 endpoint 字段落库值 */
  endpoint: string;
  /** max_tokens 预估值：上游未返回 usage 时兜底，供 lite 日志与后续计费一致性 */
  maxTokensEstimate?: number;
  /** 客户端真实 IP（从下游请求头提取，随流式日志落库；不传写 null） */
  ipAddress?: string;
  /** 客户端 User-Agent（从下游请求头提取，随流式日志落库；不传写 null） */
  userAgent?: string;
  db: D1Database;
  env?: WorkerEnv;
  /** KV 命名空间：流内密钥类错误时持久化封禁（不传仅内存态，重启丢失） */
  kv?: KVNamespace;
}): TransformStream<Uint8Array, Uint8Array> {
  let sseBuffer = "";
  let lastUsage: Record<string, unknown> | undefined;
  let streamError: { code: number; message: string } | undefined;
  let sawDone = false;
  // 空完成检测：是否收到过有效输出内容（content/reasoning_content 非空）。
  // 上游 200 + 只有 [DONE]/空 data 的伪成功流不触发空流哨兵/流内 error/截断/
  // 空闲超时任何检测，此前被记成 200 成功（管理后台常见"200 + 0 tokens +
  // 数十秒首字延迟"即此场景）
  let sawContent = false;
  let ttft = 0;
  let isFirstChunk = true;
  const decoder = new TextDecoder();

  return new TransformStream({
    transform(chunk, controller) {
      if (isFirstChunk) {
        ttft = Date.now() - params.startTime;
        isFirstChunk = false;
      }

      controller.enqueue(chunk);

      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") { sawDone = true; continue; }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          // 空完成检测：记录是否收到过有效输出内容（content/reasoning_content
          // 非空字符串；初始 role 占位 chunk 的 content 为空字符串不计）。
          // tool_calls 增量同样计入：纯工具调用流（无文本）不得误判空完成
          if (Array.isArray(parsed.choices)) {
            for (const c of parsed.choices) {
              const delta = c?.delta;
              if (delta && ((typeof delta.content === "string" && delta.content.length > 0) || (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0))) {
                sawContent = true;
              }
            }
          }
          // Responses API 流式检测：适配 Responses 协议的 delta/output
          const pAny = parsed as any;
          if (typeof pAny.delta === "string" && pAny.delta.length > 0) sawContent = true;
          if (typeof pAny.output_text === "string" && pAny.output_text.length > 0) sawContent = true;
          if (typeof pAny.text === "string" && pAny.text.length > 0 && pAny.type && String(pAny.type).includes("output_text")) sawContent = true;
          if (Array.isArray(pAny.output) && pAny.output.length > 0) sawContent = true;
          if (pAny.response?.output) sawContent = true;
          if (pAny.type === "response.completed" || pAny.type === "response.done" || pAny.response?.status === "completed" || pAny.response?.type === "response.completed") {
            sawDone = true;
          }
          // 兼容 Chat 与 Responses 两种 usage 形态
          const candidate = (pAny.usage ?? pAny.response?.usage ?? pAny.response?.response?.usage) as Record<string, unknown> | undefined;
          if (candidate) {
            lastUsage = candidate;
          }
          // 上游 200 + 流内 error 事件：失败语义由日志记录（status=error.code，isError=true）
          if (parsed.error) {
            const status = resolveStreamErrorStatus(parsed.error);
            if (status !== null) {
              streamError = {
                code: status,
                message: String(parsed.error.message || "").substring(0, 1000),
              };
            }
          }
        } catch {
          // 忽略不完整的 JSON 片段
        }
      }
    },

    async flush() {
      const { promptTokens, completionTokens, totalTokens, upstreamCost } =
        extractUsage(lastUsage, params.maxTokensEstimate);
      const duration = Date.now() - params.startTime;

      // 上游流被截断：EOF 但未收到 [DONE]（lite 不触发熔断，只如实记失败日志）。
      // 含完全空输入（无任何 chunk）：真实链路（proxy-lite 首块 read 即 done）
      // 已拦截为空响应，此处防御直接调用 transformer 的场景，同样按截断记失败
      const truncated = !sawDone && !streamError;
      // 空完成：上游 200 + 流正常 [DONE] 收尾，但全程无有效内容（无 content/
      // reasoning_content）。免费模型排队超时或上游对代理 IP 降级时常返回这种
      // "伪成功"流，客户端收到 200 + 空完成（"empty completion"）；此前记 200
      // 成功，坏平台评分不降。与截断同属失败（sawDone 使二者互斥）
      const emptyCompletion = sawDone && !streamError && !sawContent;

      // 流内 error 为密钥类状态码（429/401/402/403）时与自身 HTTP 非 2xx 透传
      // 路径（banKey + recordKeyError）及全量版 token.ts flush 对齐：封禁 Key +
      // 累加错误计数（DB errorCount 达阈值自动禁用），否则 lite 部署下
      // 「200 + 流内 429/401/402/403」永不计数，密钥自动禁用机制在流式场景漏检
      if (streamError && params.key &&
          (streamError.code === 429 || streamError.code === 401 ||
           streamError.code === 402 || streamError.code === 403)) {
        const keyErrorCode = streamError.code;
        // 经 params.kv 传完整 KV 持久化封禁：同文件 HTTP 非 2xx 路径已持久化，
        // 此前误传 workerEnv（不含 KV 字段）导致流内封禁重启即失效，两路径语义分叉
        try { await banKey(params.key, undefined, params.platformId, params.kv); } catch {}
        try { await recordKeyError(params.key, keyErrorCode, params.platformId, params.db, params.env); } catch {}
        // 平台级 429 冷却：429 是平台过载信号（区别于 Key 失效/越权），
        // 与 HTTP 429 路径 recordPlatform429 对齐——流内 429 同样计入平台冷却
        if (keyErrorCode === 429) recordPlatform429(params.platformId);
      }

      try {
        await recordRequestLog({
          keyId: params.keyId,
          keyName: params.keyName,
          platformId: params.platformId,
          model: params.model,
          // 与 Pages 版一致：endpoint 落上游真实路径（此前硬编码 "stream"）
          endpoint: params.endpoint,
          method: "POST",
          status: streamError ? streamError.code : truncated || emptyCompletion ? 502 : 200,
          tokens: streamError || truncated || emptyCompletion ? 0 : totalTokens,
          promptTokens: streamError || truncated || emptyCompletion ? 0 : promptTokens,
          completionTokens: streamError || truncated || emptyCompletion ? 0 : completionTokens,
          upstreamCost: streamError || truncated || emptyCompletion ? null : upstreamCost,
          ttft,
          duration,
          isError: !!streamError || truncated || emptyCompletion,
          errorMessage: streamError?.message ?? (emptyCompletion ? "上游返回空完成（200 + 流内无有效内容）" : truncated ? "上游流未正常结束（EOF 但未收到 [DONE]），疑似上游截断" : undefined),
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
          db: params.db,
          env: params.env,
        });
      } catch (logError) {
        console.error(
          "[proxy-lite] 流式响应日志写入失败:",
          logError instanceof Error ? logError.message : String(logError)
        );
      }
    },
  });
}

// ==================== OpenAI SSE → Anthropic SSE 转换 ====================

/**
 * OpenAI SSE → Anthropic SSE 的 TransformStream（Anthropic 协议分支专用）
 *
 * 接在 createLiteUsageTransformer 之后：usage 提取/日志仍作用于上游
 * OpenAI 流（语义不变），本转换器只把 OpenAI chunk 转成 Anthropic 事件。
 */
function createAnthropicStreamTransformerLite(
  model: string,
  inputTokens: number
): TransformStream<Uint8Array, Uint8Array> {
  const streamer = new OpenAIToAnthropicStream({ model, inputTokens });
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let errored = false;
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          // 流内 error：Anthropic 客户端靠 event: error 感知失败（与全量版语义一致）
          if (parsed.error) {
            const code = resolveStreamErrorStatus(parsed.error);
            if (code !== null) {
              errored = true;
              controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(formatAnthropicError(code, String(parsed.error.message || "").substring(0, 500)))}\n\n`));
              continue;
            }
          }
          // 纯 usage chunk（无 choices 键）也可能携带 output_tokens，不能过滤掉
          if (parsed.choices || parsed.usage) {
            const out = streamer.feedChunk(parsed);
            if (out) controller.enqueue(encoder.encode(out));
          }
        } catch {
          // 无法解析的行（非 JSON 数据）直接忽略，不影响流
        }
      }
    },
    flush(controller) {
      // 流内 error 已发事件，不再发正常收尾（message_stop）
      if (errored) return;
      const out = streamer.finish();
      if (out) controller.enqueue(encoder.encode(out));
    },
  });
}

/**
 * Anthropic SSE → OpenAI SSE 的 TransformStream（上游为 Anthropic 协议时专用）
 *
 * 接在 usage 提取之前：日志/截断检测作用于转换后的 OpenAI 流（语义不变），
 * 正常收尾输出 data: [DONE]（Anthropic 只有 message_stop，无 [DONE]）。
 */
function createOpenAIStreamTransformerLite(): TransformStream<Uint8Array, Uint8Array> {
  const streamer = new AnthropicToOpenAIStream();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          const out = streamer.feedData(parsed);
          if (out) controller.enqueue(encoder.encode(out));
        } catch {
          // 无法解析的行（非 JSON 数据）直接忽略，不影响流
        }
      }
    },
    flush(controller) {
      const out = streamer.finish();
      if (out) controller.enqueue(encoder.encode(out));
    },
  });
}

// ==================== 单次上游请求 ====================

/**
 * 处理一个 V1 代理请求（lite：单次尝试，不重试）
 */
export async function proxyV1RequestLite(
  request: Request,
  config: ProxyConfig,
  apiKey: ApiKeyRecord,
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const startTime = Date.now();
  const workerEnv: WorkerEnv = { DB_TYPE: env.DB_TYPE };

  // 客户端 IP/UA：所有请求日志（含错误分支）统一携带，日志页与导出的来源列依赖此值
  const clientInfo = extractClientInfo(request);

  // ── 1. 解析请求体 ──
  const parseResult = await parseRequestBody<Record<string, unknown>>(request);
  if ("error" in parseResult) {
    const errRes = parseResult.error;
    const errBody = (await errRes.json().catch(() => ({}))) as { error?: { message?: string } };
    return liteErrorResponse(config, errRes.status, errBody?.error?.message || "请求体解析失败", "invalid_request_error");
  }
  // multipart 请求（images/edits、audio/transcriptions 等）：model 从表单字段提取，
  // 原始字节透传上游（JSON 管道字段如 max_tokens/stream 不适用）
  let multipart: MultipartBody | null = null;
  if ("multipart" in parseResult) {
    multipart = parseResult.multipart;
    if (!multipart.model) {
      return liteErrorResponse(config, 400, "缺少 model 参数", "invalid_request_error");
    }
  }
  // TS 联合收窄：in 运算符分支后 parseResult 类型被收窄到 { multipart }，
  // 不能直接写 .body；用 in 三元取回 body 分支（error 分支已提前 return）
  const rawBody = "body" in parseResult
    ? parseResult.body
    : { model: multipart!.model as string };
  let body = rawBody;
  // Anthropic 转换器的 message_start.usage.input_tokens：用转换前请求体的输入估算
  const anthropicInputEstimate =
    config.protocol === "anthropic" ? estimateInputTokens(body) : 0;

  // ── 2. Anthropic 协议：下游 /v1/messages 请求体 → OpenAI /chat/completions 请求体 ──
  // 转换后 model/max_tokens/stream 字段名与语义对齐，后续路由/代理管道原样复用
  if (config.buildUpstreamBody) {
    try {
      body = config.buildUpstreamBody(body);
    } catch (err) {
      if (err instanceof AnthropicRequestError) {
        return Response.json(formatAnthropicError(400, err.message), { status: 400 });
      }
      throw err;
    }
  }

  // 上游未返回 usage 时的 token 兜底预估值（防 tokenLimit 绕过，与全量版
  // estimatedTokens 同源同算法）：multipart（图片/音频）请求体无 token 字段且
  // 实际消耗达数千至数万 token，按上限计；普通请求取 body 的
  // max_output_tokens/max_tokens/max_completion_tokens 并钳制到上限。
  // 与全量版一致基于转换后的 body 计算（Anthropic 转换保留 max_tokens 字段）
  const maxTokensEstimate = multipart
    ? MAX_ESTIMATED_TOKENS
    : Math.min(
        MAX_ESTIMATED_TOKENS,
        Math.max(1, Number((body as any).max_output_tokens || body.max_tokens || body.max_completion_tokens) || 1)
      );

  // ── 3. 路由（纯负载均衡：权重随机，无评分/优先级/熔断） ──
  const modelName = body.model as string | undefined;
  if (!modelName) {
    // 客户端漏传 model（/v1/models 之外所有端点必填）：按 4xx 返回，
    // 此前用 "__any__" 兜底恒路由失败返回 500，把客户端错误伪装成
    // 服务器故障并污染错误统计
    return liteErrorResponse(config, 400, "缺少 model 参数", "invalid_request_error");
  }
  const requestedModel = modelName;
  const sourceApi = config.upstreamPath === "/responses" ? "responses" as const : "chat" as const;
  const route = await routeRequestLite(requestedModel, env.DB, workerEnv, sourceApi);
  if (!route) {
    // 路由失败：平台维度未知记 null（配置问题，不计入任何平台评分）
    try {
      await recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: null,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status: 500,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: true,
        errorMessage: "此模型不存在",
        ipAddress: clientInfo.ipAddress,
        userAgent: clientInfo.userAgent,
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error("[proxy-lite] 日志写入失败:", logError);
    }
    // 与全量版 proxy.ts 一致：路由/模型不存在属服务器侧配置问题，返回 server_error
    return liteErrorResponse(config, 500, "此模型不存在", "server_error");
  }

  // ── 3. 选择平台 Key（轮询，跳过已封禁/降级） ──
  const currentKey = getNextKey(route.platform);
  if (!currentKey) {
    // 当前平台无可用 Key：计入该平台错误统计
    try {
      await recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: route.platform.id,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status: 500,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: true,
        errorMessage: `平台 "${route.platform.name}" 无可用 API Key`,
        ipAddress: clientInfo.ipAddress,
        userAgent: clientInfo.userAgent,
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error("[proxy-lite] 日志写入失败:", logError);
    }
    // 告警：lite 部署单平台即全部——平台无可用 Key 等价服务不可用
    void sendNotification(
      "all_unavailable",
      `平台无可用 API Key: ${route.platform.name}`,
      `模型 ${requestedModel} 的请求无可用 Key，已返回 500`,
      { db: env.DB, env: workerEnv }
    );
    return liteErrorResponse(config, 500, `平台 "${route.platform.name}" 无可用 API Key`, "server_error");
  }

  // ── 4. 构建上游请求 ──
  // 上游为 Anthropic 协议：请求体转回 /v1/messages 格式，URL 指向 /v1/messages，
  // 认证用 x-api-key + anthropic-version
  const upstreamIsAnthropic = route.platform.type === "anthropic";
  // chat↔responses 互转已移除，下游端点与上游端点原样透传
  const effectiveUpstreamPath = config.upstreamPath;

  let upstreamBody: Record<string, unknown>;
  if (upstreamIsAnthropic) {
    try {
      upstreamBody = convertOpenAIRequest({
        ...body,
        model: route.targetModel,
      });
    } catch (convertError) {
      if (convertError instanceof OpenAIRequestError) {
        return liteErrorResponse(config, 400, convertError.message, "invalid_request_error");
      }
      throw convertError;
    }
  } else {
    upstreamBody = { ...body, model: route.targetModel };
  }

  const isStream = config.supportsStreaming !== false && upstreamBody.stream === true;
  // 流式请求注入 stream_options：仅当平台开启了注入开关时添加
  // 部分严格后端（Mistral 等 FastAPI/pydantic 校验）拒绝未知字段，返回 422 extra_forbidden
  // 用户可在平台管理页关闭此选项以兼容这类上游
  // Anthropic 协议上游同样拒绝未知字段，且 convertOpenAIRequest 已白名单剥离
  // Responses 端点不注入 stream_options
  if (isStream && route.platform.injectStreamOptions !== false && !upstreamIsAnthropic && effectiveUpstreamPath !== "/responses") {
    upstreamBody.stream_options = { include_usage: true };
  }

  // 解析透传头（只保留合法 header 名，Workers fetch 对非法名会抛 TypeError）
  const rawForwardHeaders = extractForwardableHeaders(
    request.headers,
    route.platform.forwardHeaders
  );
  const forwardHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawForwardHeaders)) {
    // 只保留合法 header 名
    if (!/^[a-zA-Z0-9-]+$/.test(k)) continue;
    // 丢弃认证类/请求语义关键头（大小写不敏感）：白名单展开在认证头与
    // extraHeaders 之前，若允许透传覆盖则下游客户端可替换平台密钥或破坏请求语义
    if (FORBIDDEN_FORWARD_HEADERS.has(k.toLowerCase())) continue;
    forwardHeaders[k] = v;
  }

  const upstreamUrl = upstreamIsAnthropic
      ? `${route.platform.baseUrl.replace(/\/+$/, "")}/v1/messages`
      : `${route.platform.baseUrl.replace(/\/+$/, "")}${effectiveUpstreamPath}`;

  // SSRF 防护：校验上游 URL
  const urlCheck = isSafeUpstreamUrl(route.platform.baseUrl);
  if (!urlCheck.safe) {
    try {
      await recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: route.platform.id,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status: 400,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: true,
        errorMessage: `上游 URL 不安全: ${urlCheck.reason}`,
        ipAddress: clientInfo.ipAddress,
        userAgent: clientInfo.userAgent,
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error("[proxy-lite] 日志写入失败:", logError);
    }
    return liteErrorResponse(config, 400, `上游 URL 不安全: ${urlCheck.reason}`, "invalid_request_error");
  }

  // ── 5. 发送上游请求（单次，不重试） ──
  const upstreamController = new AbortController();
  const upstreamTimeoutId = setTimeout(
    () => upstreamController.abort(),
    UPSTREAM_TIMEOUT_MS
  );
  let upstreamResponse: Response;
  try {
    const headers: Record<string, string> = {
      // multipart 请求：Content-Type 必须保留原始 boundary，否则上游无法解析表单
      "Content-Type": multipart ? multipart.contentType : "application/json",
      // Anthropic 协议上游：x-api-key + anthropic-version（extraHeaders 可覆盖为
      // Authorization 等，GitHub Copilot 等 OAuth 网关需用户自行配置）
      ...(upstreamIsAnthropic
        ? { "x-api-key": currentKey, "anthropic-version": "2023-06-01" }
        : { Authorization: `Bearer ${currentKey}` }),
      ...forwardHeaders,
      // 高级设置：自定义请求头（强制覆盖），优先级高于下游透传头
      ...parseExtraHeaders(route.platform.extraHeaders),
    };
    // 高级设置：UA 复用（自定义 UA 优先级最高，覆盖 extraHeaders 中的 User-Agent）
    if (route.platform.reuseUserAgent && route.platform.customUserAgent) {
      headers["User-Agent"] = route.platform.customUserAgent;
    }
    upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: multipart ? multipart.raw : JSON.stringify(upstreamBody),
      signal: upstreamController.signal,
      // 禁止跟随重定向：isSafeUpstreamUrl 只校验初始 URL，
      // 跟随 3xx 可能将请求重定向到内网（SSRF / DNS rebinding TOCTOU）
      redirect: "manual",
    });
  } catch (fetchError) {
    clearTimeout(upstreamTimeoutId);
    // 网络层失败（总超时中止 / DNS 解析失败 / 连接拒绝等）统一补记请求日志再返回
    // 明确错误——此前非 AbortError 直接 throw 冒泡到入口 catch 返回 500，
    // request_logs 零记录、可用率统计被高估（与全量版 proxy.ts 网络层失败分支
    // 对齐；lite 无熔断器，只补日志不触发平台级处置）
    // AbortError 判断兼容 DOMException 与 Error 两种实现：Worker 原生 fetch 抛
    // DOMException，Node/undici 抛 Error——只判 DOMException 会漏判超时
    const isAbort =
      (fetchError instanceof DOMException ||
        fetchError instanceof Error) &&
      fetchError.name === "AbortError";
    const status = isAbort ? 504 : 502;
    const errorMessage = isAbort
      ? "上游请求超时"
      : `上游请求失败: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`;
    try {
      await recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: route.platform.id,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: true,
        errorMessage,
        ipAddress: clientInfo.ipAddress,
        userAgent: clientInfo.userAgent,
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error("[proxy-lite] 日志写入失败:", logError);
    }
    if (isAbort) {
      return liteErrorResponse(config, 504, "上游请求超时（2 分钟），请稍后重试", "timeout_error");
    }
    return liteErrorResponse(config, 502, "上游请求失败（网络错误），请稍后重试", "upstream_error");
  }

  // ── 6. 2xx 成功响应：正常处理（流式/非流式） ──
  if (upstreamResponse.status >= 200 && upstreamResponse.status < 300) {
    return handleUpstreamResponseLite(
      upstreamResponse,
      route.platform,
      apiKey,
      requestedModel,
      config,
      isStream,
      startTime,
      env,
      ctx,
      workerEnv,
      upstreamController,
      upstreamTimeoutId,
      anthropicInputEstimate,
      maxTokensEstimate,
      currentKey,
      clientInfo
    );
  }

  // ── 非 2xx：真实透传（不重试、不熔断） + 错误日志 + 错误计数 ──
  let errorText = "";
  try {
    errorText = await upstreamResponse.text();
  } catch {
    // 读取错误体失败（如 signal 超时），保留空错误体
  }
  clearTimeout(upstreamTimeoutId);

  // 上游 3xx（redirect:"manual" 不跟随）：重定向目标未经 SSRF 校验，裸 3xx
  // 对客户端无意义，属平台 baseUrl 配置错误而非平台故障。与全量版及 Pages v1
  // 对齐转 502 明确提示（lite 无熔断器，不计失败）
  if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
    try {
      await recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: route.platform.id,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status: upstreamResponse.status,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: true,
        errorMessage: `上游返回重定向（HTTP ${upstreamResponse.status}），请检查平台 baseUrl 配置`,
        ipAddress: clientInfo.ipAddress,
        userAgent: clientInfo.userAgent,
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error("[proxy-lite] 日志写入失败:", logError);
    }
    return liteErrorResponse(config, 502, "上游返回重定向，请检查平台 baseUrl 配置", "upstream_error");
  }

  // 密钥类状态码（429/401/402/403）：封禁 Key + 累加错误计数（达 5 次自动禁用；
  // 402 = Payment Required 计数 +5 立即禁用，与全量版 RETRYABLE_UPSTREAM_STATUSES
  // 及流内 error 路径对齐——此前只计数不封禁，两条路径行为分叉；banKey 传入
  // KV 使封禁态持久化，避免 Worker 冷启动后丢失）
  if (currentKey && (upstreamResponse.status === 429 || upstreamResponse.status === 401 || upstreamResponse.status === 402 || upstreamResponse.status === 403)) {
    ctx.waitUntil(banKey(currentKey, undefined, route.platform.id, env.KV).catch(() => {}));
    ctx.waitUntil(recordKeyError(currentKey, upstreamResponse.status, route.platform.id, env.DB, workerEnv).catch(() => {}));
    // 平台级 429 冷却：429 是平台过载信号（区别于 Key 失效/越权），
    // 与全量版 HTTP 429 路径对齐——lite 无重试，冷却由调度层（selectPlatform）生效
    if (upstreamResponse.status === 429) recordPlatform429(route.platform.id);
  }

  try {
    await recordRequestLog({
      keyId: apiKey.id,
      keyName: apiKey.name,
      platformId: route.platform.id,
      model: requestedModel,
      endpoint: config.upstreamPath,
      method: "POST",
      status: upstreamResponse.status,
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      ttft: 0,
      duration: Date.now() - startTime,
      isError: true,
      errorMessage: extractUpstreamErrorMessage(errorText).substring(0, 1000),
      ipAddress: clientInfo.ipAddress,
      userAgent: clientInfo.userAgent,
      db: env.DB,
      env: workerEnv,
    });
  } catch (logError) {
    console.error("[proxy-lite] 日志写入失败:", logError);
  }

  if (config.protocol === "anthropic") {
    return Response.json(
      formatAnthropicError(upstreamResponse.status, sanitizeMessage(extractUpstreamErrorMessage(errorText), upstreamResponse.status)),
      { status: upstreamResponse.status }
    );
  }
  const errorBody = sanitizeUpstreamError(errorText, upstreamResponse.status);
  return new Response(errorBody, {
    status: upstreamResponse.status,
    headers: { "Content-Type": "application/json" },
  });
}

// ==================== 上游响应处理（lite） ====================

/**
 * 处理上游成功响应（流式/非流式），只写请求日志
 *
 * @returns 正常响应（空响应体/空流时返回 502 错误，与全量版重试耗尽后的终态一致）
 */
async function handleUpstreamResponseLite(
  upstreamResponse: Response,
  platform: { id: string; name: string; type?: string },
  apiKey: ApiKeyRecord,
  requestedModel: string,
  config: ProxyConfig,
  isStream: boolean,
  startTime: number,
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext,
  workerEnv: WorkerEnv,
  upstreamController: AbortController,
  upstreamTimeoutId: ReturnType<typeof setTimeout>,
  anthropicInputEstimate: number,
  /** max_tokens 兜底预估值：上游未返回 usage 时兜底记账（防 tokenLimit 绕过，与全量版一致） */
  maxTokensEstimate: number,
  currentKey: string,
  /** 客户端 IP/UA（下游请求头提取）：所有日志分支落库来源信息 */
  clientInfo?: { ipAddress?: string; userAgent?: string }
): Promise<Response> {
  // 上游是否为 Anthropic 协议：响应需先转成 OpenAI 内部格式再走 usage/下游转换管线
  const upstreamIsAnthropic = platform.type === "anthropic";
  // 流式响应（SSE）
  if (isStream) {
    const stream = upstreamResponse.body;
    if (!stream) {
      clearTimeout(upstreamTimeoutId);
      return liteErrorResponse(config, 500, "上游未返回流式响应", "server_error");
    }

    // 先读第一块判断是否为空流：200 + 空 SSE（首个 read 即 done）视为空响应
    const streamReader = stream.getReader();
    let firstChunk: ReadableStreamReadResult<Uint8Array>;
    try {
      firstChunk = await streamReader.read();
    } catch (readError) {
      clearTimeout(upstreamTimeoutId);
      if (upstreamController.signal.aborted) {
        return liteErrorResponse(config, 504, "上游响应读取超时（2 分钟），请稍后重试", "timeout_error");
      }
      console.error("[proxy-lite] 流式响应首块读取失败:", readError);
      return liteErrorResponse(config, 500, "读取上游响应失败", "server_error");
    }
    if (firstChunk.done) {
      // 空流：无重试机制，直接记空响应失败（与全量版重试耗尽后的终态一致）
      clearTimeout(upstreamTimeoutId);
      streamReader.releaseLock();
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: platform.id,
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
          errorMessage: "上游返回空响应",
          ipAddress: clientInfo?.ipAddress,
          userAgent: clientInfo?.userAgent,
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error("[proxy-lite] 日志写入失败:", logError);
      }
      // 空响应与全量版重试路径/Pages 版对齐：封禁 Key 5 分钟 + 计数
      // （此前只计数不封禁，坏平台需累计 5 次才自动禁用，期间持续吞掉请求）
      if (currentKey) {
        ctx.waitUntil(banKey(currentKey, undefined, platform.id, env.KV).catch(() => {}));
        ctx.waitUntil(recordKeyError(currentKey, 502, platform.id, env.DB, workerEnv).catch(() => {}));
      }
      return liteErrorResponse(config, 502, "上游返回空响应", "upstream_error");
    }

    // 总超时使命完成：流式响应允许长时间持续传输，改由空闲超时保护（无数据才切断）
    clearTimeout(upstreamTimeoutId);

    // 把已读到的第一块拼回流头部，继续透传
    const paddedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstChunk.value);
      },
      pull(controller) {
        return streamReader.read().then(
          ({ done, value }) => {
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          },
          (err) => {
            // 上游流被取消（空闲超时切断）时 pending read 会 reject；控制器已关闭则忽略
            try {
              controller.error(err);
            } catch {
              // 控制器已关闭/error（cancel 路径），忽略二次错误
            }
          }
        );
      },
      cancel(reason) {
        return streamReader.cancel(reason);
      },
    });

    const transformer = createLiteUsageTransformer({
      keyId: apiKey.id,
      keyName: apiKey.name,
      platformId: platform.id,
      model: requestedModel,
      startTime,
      // 流内密钥类错误（429/401/402/403）时封禁+计数（与 HTTP 透传路径对齐）
      key: currentKey,
      endpoint: config.upstreamPath,
      // 上游未返回 usage 时以请求体 max_tokens 预估值兜底记账（防 tokenLimit 绕过）
      maxTokensEstimate,
      ipAddress: clientInfo?.ipAddress,
      userAgent: clientInfo?.userAgent,
      db: env.DB,
      env: workerEnv,
      kv: env.KV,
    });

    // 空闲超时置于 transformer 之前，直接包装上游流：只有上游真正无数据时才切断，
    // 下游消费慢（背压）不会误判。挂起超时时 transformer 输入被 error 不会 flush，
    // 由 onTimeout 补记超时错误日志。
    const guardedStream = withIdleTimeout(
      paddedStream,
      UPSTREAM_IDLE_TIMEOUT_MS,
      () => {
        // 用 ctx.waitUntil 保护补记日志：超时路径下请求随即终结，
        // 在途 DB 写入会被 isolate 冻结截断
        ctx.waitUntil(
          recordRequestLog({
            keyId: apiKey.id,
            keyName: apiKey.name,
            platformId: platform.id,
            model: requestedModel,
            endpoint: config.upstreamPath,
            method: "POST",
            status: 504,
            tokens: 0,
            promptTokens: 0,
            completionTokens: 0,
            ttft: 0,
            duration: Date.now() - startTime,
            isError: true,
            errorMessage: `上游响应空闲超时（${UPSTREAM_IDLE_TIMEOUT_MS / 1000} 秒无数据）`,
            ipAddress: clientInfo?.ipAddress,
            userAgent: clientInfo?.userAgent,
            db: env.DB,
            env: workerEnv,
          }).catch((logError) => {
            console.error("[proxy-lite] 空闲超时日志写入失败:", logError);
          })
        );
      }
    );
    // 上游 Anthropic 协议：先把 Anthropic 事件流转成 OpenAI chunk 流，
    // usage 提取/截断检测才能按 OpenAI 语义工作（[DONE] 收尾、usage 字段）
    let pipeline: ReadableStream<Uint8Array> = guardedStream;
    if (upstreamIsAnthropic) {
      pipeline = pipeline.pipeThrough(createOpenAIStreamTransformerLite());
    }
    const pipedStream = pipeline.pipeThrough(transformer);
    // Anthropic 协议：OpenAI SSE → Anthropic 事件流
    const finalStream = config.protocol === "anthropic"
      ? pipedStream.pipeThrough(createAnthropicStreamTransformerLite(requestedModel, anthropicInputEstimate))
      : pipedStream;

    return new Response(finalStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        // no-transform 防止中间代理/网关对 SSE 流做 gzip 缓冲
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  // 非流式响应
  const responseContentType =
    upstreamResponse.headers.get("content-type") || "";

  // multipart 响应（audio/images）直接透传（同样受空闲超时保护）
  if (responseContentType.includes("multipart/")) {
    const multipartBody = upstreamResponse.body;
    if (!multipartBody) {
      clearTimeout(upstreamTimeoutId);
      return liteErrorResponse(config, 500, "上游未返回响应体", "server_error");
    }
    // 先读第一块判断是否为空：空 multipart 视为空响应
    const multipartReader = multipartBody.getReader();
    let firstMultipart: ReadableStreamReadResult<Uint8Array>;
    try {
      firstMultipart = await multipartReader.read();
    } catch {
      clearTimeout(upstreamTimeoutId);
      if (upstreamController.signal.aborted) {
        return liteErrorResponse(config, 504, "上游响应读取超时（2 分钟），请稍后重试", "timeout_error");
      }
      return liteErrorResponse(config, 500, "读取上游响应失败", "server_error");
    }
    if (firstMultipart.done) {
      clearTimeout(upstreamTimeoutId);
      multipartReader.releaseLock();
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: platform.id,
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
          errorMessage: "上游返回空响应",
          ipAddress: clientInfo?.ipAddress,
          userAgent: clientInfo?.userAgent,
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error("[proxy-lite] 日志写入失败:", logError);
      }
      // 空响应与全量版重试路径/Pages 版对齐：封禁 Key 5 分钟 + 计数
      // （此前只计数不封禁，坏平台需累计 5 次才自动禁用，期间持续吞掉请求）
      if (currentKey) {
        ctx.waitUntil(banKey(currentKey, undefined, platform.id, env.KV).catch(() => {}));
        ctx.waitUntil(recordKeyError(currentKey, 502, platform.id, env.DB, workerEnv).catch(() => {}));
      }
      return liteErrorResponse(config, 502, "上游返回空响应", "upstream_error");
    }

    clearTimeout(upstreamTimeoutId);

    // 不阻塞响应：成功日志后置到 waitUntil（与流式分支一致）
    ctx.waitUntil(
      recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: platform.id,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status: 200,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: false,
        ipAddress: clientInfo?.ipAddress,
        userAgent: clientInfo?.userAgent,
        db: env.DB,
        env: workerEnv,
      }).catch((logError) => {
        console.error("[proxy-lite] 日志写入失败:", logError);
      })
    );

    // 把已读到的第一块拼回流头部，继续透传
    const multipartPadded = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstMultipart.value);
      },
      pull(controller) {
        return multipartReader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        });
      },
      cancel(reason) {
        return multipartReader.cancel(reason);
      },
    });
    return new Response(
      withIdleTimeout(
        multipartPadded,
        UPSTREAM_IDLE_TIMEOUT_MS,
        () => {
          // 挂起超时补记 504（与 SSE 分支一致）：用 ctx.waitUntil 保护补记日志，
          // 超时路径下请求随即终结，在途 DB 写入会被 isolate 冻结截断
          ctx.waitUntil(
            recordRequestLog({
              keyId: apiKey.id,
              keyName: apiKey.name,
              platformId: platform.id,
              model: requestedModel,
              endpoint: config.upstreamPath,
              method: "POST",
              status: 504,
              tokens: 0,
              promptTokens: 0,
              completionTokens: 0,
              ttft: 0,
              duration: Date.now() - startTime,
              isError: true,
              errorMessage: `上游响应空闲超时（${UPSTREAM_IDLE_TIMEOUT_MS / 1000} 秒无数据）`,
              db: env.DB,
              env: workerEnv,
            }).catch((logError) => {
              console.error("[proxy-lite] 空闲超时日志写入失败:", logError);
            })
          );
        }
      ),
      {
        status: upstreamResponse.status,
        headers: { "Content-Type": responseContentType },
      }
    );
  }

  // JSON 响应（signal 继续保护响应体读取：120s 内未读完即中止）
  let responseBody: string;
  try {
    responseBody = await upstreamResponse.text();
  } catch {
    clearTimeout(upstreamTimeoutId);
    if (upstreamController.signal.aborted) {
      return liteErrorResponse(config, 504, "上游响应读取超时（2 分钟），请稍后重试", "timeout_error");
    }
    return liteErrorResponse(config, 500, "读取上游响应失败", "server_error");
  } finally {
    clearTimeout(upstreamTimeoutId);
  }

  // 空响应：2xx 但响应体为空（上游返回空 body）
  if (!responseBody.trim()) {
    try {
      await recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: platform.id,
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
        errorMessage: "上游返回空响应",
        ipAddress: clientInfo?.ipAddress,
        userAgent: clientInfo?.userAgent,
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error("[proxy-lite] 日志写入失败:", logError);
    }
    // 空响应与全量版重试路径/Pages 版对齐：封禁 Key 5 分钟 + 计数
    // （此前只计数不封禁，坏平台需累计 5 次才自动禁用，期间持续吞掉请求）
    if (currentKey) {
      ctx.waitUntil(banKey(currentKey, undefined, platform.id, env.KV).catch(() => {}));
      ctx.waitUntil(recordKeyError(currentKey, 502, platform.id, env.DB, workerEnv).catch(() => {}));
    }
    return liteErrorResponse(config, 502, "上游返回空响应", "upstream_error");
  }

  // 提取 usage（只写日志，不更新 Key 用量）
  let responseTokens = 0;
  let responsePromptTokens = 0;
  let responseCompletionTokens = 0;
  // 上游自报实时成本（usage.cost），成功日志优先采信
  let responseUpstreamCost: number | null = null;

  // 上游为 Anthropic 协议：先转成 OpenAI 内部格式（usage 提取与下游转换共用同一对象）；
  // 转换失败（非 JSON / 结构异常）时 openaiBody 为 null，交由下方 502 分支处理
  let openaiBody: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    openaiBody = upstreamIsAnthropic
      ? convertAnthropicResponse(parsed, requestedModel)
      : parsed;
    const usage = openaiBody.usage as Record<string, unknown> | undefined;
    if (usage) {
      // 传入 max_tokens 预估值防篡改（usage 全 0 时兜底记账，与全量版一致）
      const extracted = extractUsage(usage, maxTokensEstimate);
      responseTokens = extracted.totalTokens;
      responsePromptTokens = extracted.promptTokens;
      responseCompletionTokens = extracted.completionTokens;
      responseUpstreamCost = extracted.upstreamCost;
    }
  } catch {
    // JSON 解析失败不影响响应
  }

  if (config.protocol === "anthropic") {
    // OpenAI chat.completion → Anthropic message（回显下游请求的模型名）
    try {
      if (!openaiBody) throw new Error("unparseable");
      const converted = JSON.stringify(
        convertOpenAIResponse(openaiBody, requestedModel)
      );
      // 不阻塞响应：成功日志后置到 waitUntil（与流式分支一致）
      ctx.waitUntil(
        recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: platform.id,
          model: requestedModel,
          endpoint: config.upstreamPath,
          method: "POST",
          status: 200,
          tokens: responseTokens,
          promptTokens: responsePromptTokens,
          completionTokens: responseCompletionTokens,
          upstreamCost: responseUpstreamCost,
          ttft: 0,
          duration: Date.now() - startTime,
          isError: false,
          ipAddress: clientInfo?.ipAddress,
          userAgent: clientInfo?.userAgent,
          db: env.DB,
          env: workerEnv,
        }).catch((logError) => {
          console.error("[proxy-lite] 日志写入失败:", logError);
        })
      );
      return new Response(converted, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      // 转换失败（上游返回了意外的 JSON 结构）：不记成功日志，按 502 处理。
      // 补记失败日志再返回（与全量版同场景对齐）：此前直接返回 502 零落痕，
      // 日志页只见客户端报错不见平台侧记录，可用率统计被高估
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: platform.id,
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
          errorMessage: "上游响应格式错误",
          ipAddress: clientInfo?.ipAddress,
          userAgent: clientInfo?.userAgent,
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error("[proxy-lite] 日志写入失败:", logError);
      }
      // 错误文案与全量版/Pages 版同场景对齐（此前为「上游响应格式无法转换」）
      return liteErrorResponse(config, 502, "上游响应格式错误", "upstream_error");
    }
  }

  // 不阻塞响应：成功日志后置到 waitUntil（与流式分支一致）
  ctx.waitUntil(
    recordRequestLog({
      keyId: apiKey.id,
      keyName: apiKey.name,
      platformId: platform.id,
      model: requestedModel,
      endpoint: config.upstreamPath,
      method: "POST",
      status: 200,
      tokens: responseTokens,
      promptTokens: responsePromptTokens,
      completionTokens: responseCompletionTokens,
      upstreamCost: responseUpstreamCost,
      ttft: 0,
      duration: Date.now() - startTime,
      isError: false,
      ipAddress: clientInfo?.ipAddress,
      userAgent: clientInfo?.userAgent,
      db: env.DB,
      env: workerEnv,
    }).catch((logError) => {
      console.error("[proxy-lite] 日志写入失败:", logError);
    })
  );

  // 上游为 Anthropic 协议时下游收到的是转换后的 OpenAI 格式（openaiBody 解析失败
  // 时保持透传原文，与 OpenAI 上游非 JSON 响应行为一致）
  // chat↔responses 互转已移除，非流式响应原样透传
  const finalBody = upstreamIsAnthropic && openaiBody ? JSON.stringify(openaiBody) : responseBody;
  return new Response(finalBody, {
    status: upstreamResponse.status,
    headers: { "Content-Type": responseContentType },
  });
}
