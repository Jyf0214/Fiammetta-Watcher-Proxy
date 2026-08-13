/**
 * Lite 版上游代理 — 单次尝试，不重试、不封禁、不熔断
 *
 * VERSION=lite 时构建使用，以最小化 CPU 运行时间：
 * - 单次上游请求：429/401/403/5xx/空响应一律真实透传，不换 Key 不换平台
 * - 只写请求日志（request_logs）：不含熔断器写入、Key 用量更新、速率限制
 * - 流式响应仍做 usage/TTFT 提取（日志质量与全量版一致，供管理后台展示）
 * - 不应用请求模板、不检查平台/Key 级 RPM/TPM
 */

import { routeRequestLite } from "./router-lite";
import { getNextKey } from "./platform-keys";
import { recordRequestLog, extractUsage, resolveStreamErrorStatus } from "./token";
import { withIdleTimeout } from "./stream-guard";
import { extractForwardableHeaders } from "./forward-headers";
import { isSafeUpstreamUrl } from "@/lib/ssrf";
import {
  convertOpenAIResponse,
  OpenAIToAnthropicStream,
  formatAnthropicError,
  AnthropicRequestError,
  estimateInputTokens,
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
 * 脱敏上游错误响应，仅提取错误消息
 */
function sanitizeUpstreamError(errorText: string, upstreamStatus: number): string {
  return JSON.stringify({
    error: {
      message: extractUpstreamErrorMessage(errorText),
      type: "upstream_error",
      upstream_status: upstreamStatus,
    },
  });
}

/**
 * 按协议构造错误响应：anthropic 用 {type:"error",error:{type,message}}，
 * openai 保持 {error:{message,type,...}}。状态码两边保持一致。
 */
function liteErrorResponse(
  cfg: ProxyConfig,
  status: number,
  message: string,
  type: string,
  extra?: Record<string, unknown>
): Response {
  if (cfg.protocol === "anthropic") {
    return Response.json(formatAnthropicError(status, message, type), { status });
  }
  return Response.json({ error: { message, type, ...extra } }, { status });
}

// ==================== 配置常量（与全量版 proxy.ts 保持一致） ====================

/** 上游请求总超时（等待响应头 + 非流式响应体） */
const UPSTREAM_TIMEOUT_MS = 120_000;

/** 流式响应空闲超时：距上次收到数据超过该时长即切断 */
const UPSTREAM_IDLE_TIMEOUT_MS = 120_000;

/** 请求体大小上限 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

// ==================== 请求体解析 ====================

async function parseRequestBody<T>(
  request: Request
): Promise<{ body: T } | { error: Response }> {
  if (Number(request.headers.get("content-length") || "0") > MAX_BODY_BYTES) {
    return {
      error: Response.json(
        { error: { message: "请求体过大", type: "invalid_request_error" } },
        { status: 413 }
      ),
    };
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

  if (!rawText) {
    return { body: {} as T };
  }

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
  db: D1Database;
  env?: WorkerEnv;
}): TransformStream<Uint8Array, Uint8Array> {
  let sseBuffer = "";
  let lastUsage: Record<string, unknown> | undefined;
  let streamError: { code: number; message: string } | undefined;
  let sawDone = false;
  let ttft = 0;
  let isFirstChunk = true;
  let chunkCount = 0;
  const decoder = new TextDecoder();

  return new TransformStream({
    transform(chunk, controller) {
      chunkCount++;

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
          if (parsed.usage) {
            lastUsage = parsed.usage;
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
      const { promptTokens, completionTokens, totalTokens } =
        extractUsage(lastUsage);
      const duration = Date.now() - params.startTime;

      // 上游流被截断：EOF 但未收到 [DONE]（lite 不触发熔断，只如实记失败日志）
      const truncated = !sawDone && !streamError && chunkCount > 0;

      try {
        await recordRequestLog({
          keyId: params.keyId,
          keyName: params.keyName,
          platformId: params.platformId,
          model: params.model,
          endpoint: "stream",
          method: "POST",
          status: streamError ? streamError.code : truncated ? 502 : 200,
          tokens: streamError || truncated ? 0 : totalTokens,
          promptTokens: streamError || truncated ? 0 : promptTokens,
          completionTokens: streamError || truncated ? 0 : completionTokens,
          ttft,
          duration,
          isError: !!streamError || truncated,
          errorMessage: streamError?.message ?? (truncated ? "上游流未正常结束（EOF 但未收到 [DONE]），疑似上游截断" : undefined),
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

  // ── 1. 解析请求体 ──
  const parseResult = await parseRequestBody<Record<string, unknown>>(request);
  if ("error" in parseResult) {
    const errRes = parseResult.error;
    const errBody = (await errRes.json().catch(() => ({}))) as { error?: { message?: string } };
    return liteErrorResponse(config, errRes.status, errBody?.error?.message || "请求体解析失败", "invalid_request_error");
  }
  let body = parseResult.body;
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

  // ── 3. 路由（纯负载均衡：权重随机，无评分/优先级/熔断） ──
  const requestedModel = (body.model as string | undefined) || "unknown";
  const route = body.model
    ? await routeRequestLite(requestedModel, env.DB, workerEnv)
    : await routeRequestLite("__any__", env.DB, workerEnv);
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
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error("[proxy-lite] 日志写入失败:", logError);
    }
    return liteErrorResponse(config, 500, "此模型不存在", "invalid_request_error");
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
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error("[proxy-lite] 日志写入失败:", logError);
    }
    return liteErrorResponse(config, 500, `平台 "${route.platform.name}" 无可用 API Key`, "server_error");
  }

  // ── 4. 构建上游请求 ──
  const upstreamBody: Record<string, unknown> = { ...body, model: route.targetModel };

  const isStream = config.supportsStreaming !== false && body.stream === true;
  // 流式请求注入 stream_options：仅当平台开启了注入开关时添加
  // 部分严格后端（Mistral 等 FastAPI/pydantic 校验）拒绝未知字段，返回 422 extra_forbidden
  // 用户可在平台管理页关闭此选项以兼容这类上游
  if (isStream && route.platform.injectStreamOptions !== false) {
    upstreamBody.stream_options = { include_usage: true };
  }

  // 解析透传头（只保留合法 header 名，Workers fetch 对非法名会抛 TypeError）
  const rawForwardHeaders = extractForwardableHeaders(
    request.headers,
    route.platform.forwardHeaders
  );
  const forwardHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawForwardHeaders)) {
    if (/^[a-zA-Z0-9-]+$/.test(k)) {
      forwardHeaders[k] = v;
    }
  }

  const upstreamUrl = `${route.platform.baseUrl.replace(/\/+$/, "")}${config.upstreamPath}`;

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
    upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${currentKey}`,
        ...forwardHeaders,
      },
      body: JSON.stringify(upstreamBody),
      signal: upstreamController.signal,
      // 禁止跟随重定向：isSafeUpstreamUrl 只校验初始 URL，
      // 跟随 3xx 可能将请求重定向到内网（SSRF / DNS rebinding TOCTOU）
      redirect: "manual",
    });
  } catch (fetchError) {
    clearTimeout(upstreamTimeoutId);
    if (
      fetchError instanceof DOMException &&
      fetchError.name === "AbortError"
    ) {
      // 上游请求超时：计入该平台错误统计
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: route.platform.id,
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
          errorMessage: "上游请求超时",
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error("[proxy-lite] 日志写入失败:", logError);
      }
      return liteErrorResponse(config, 504, "上游请求超时（2 分钟），请稍后重试", "timeout_error");
    }
    throw fetchError;
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
      anthropicInputEstimate
    );
  }

  // ── 非 2xx：真实透传（不重试、不封禁、不熔断） + 错误日志 ──
  let errorText = "";
  try {
    errorText = await upstreamResponse.text();
  } catch {
    // 读取错误体失败（如 signal 超时），保留空错误体
  }
  clearTimeout(upstreamTimeoutId);

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
      db: env.DB,
      env: workerEnv,
    });
  } catch (logError) {
    console.error("[proxy-lite] 日志写入失败:", logError);
  }

  if (config.protocol === "anthropic") {
    return Response.json(
      formatAnthropicError(upstreamResponse.status, extractUpstreamErrorMessage(errorText)),
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
  platform: { id: string; name: string },
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
  anthropicInputEstimate: number
): Promise<Response> {
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
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error("[proxy-lite] 日志写入失败:", logError);
      }
      return liteErrorResponse(config, 502, "上游返回空响应，请求已重试仍无内容", "upstream_error");
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
      db: env.DB,
      env: workerEnv,
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
            db: env.DB,
            env: workerEnv,
          }).catch((logError) => {
            console.error("[proxy-lite] 空闲超时日志写入失败:", logError);
          })
        );
      }
    );
    const pipedStream = guardedStream.pipeThrough(transformer);
    // Anthropic 协议：OpenAI SSE → Anthropic 事件流（在 usage 统计之后转换）
    const finalStream = config.protocol === "anthropic"
      ? pipedStream.pipeThrough(createAnthropicStreamTransformerLite(requestedModel, anthropicInputEstimate))
      : pipedStream;

    return new Response(finalStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
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
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error("[proxy-lite] 日志写入失败:", logError);
      }
      return liteErrorResponse(config, 502, "上游返回空响应，请求已重试仍无内容", "upstream_error");
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
      withIdleTimeout(multipartPadded, UPSTREAM_IDLE_TIMEOUT_MS),
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
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error("[proxy-lite] 日志写入失败:", logError);
    }
    return liteErrorResponse(config, 502, "上游返回空响应，请求已重试仍无内容", "upstream_error");
  }

  // 提取 usage（只写日志，不更新 Key 用量）
  let responseTokens = 0;
  let responsePromptTokens = 0;
  let responseCompletionTokens = 0;

  try {
    const parsed = JSON.parse(responseBody);
    const usage = parsed?.usage;
    if (usage) {
      const extracted = extractUsage(usage);
      responseTokens = extracted.totalTokens;
      responsePromptTokens = extracted.promptTokens;
      responseCompletionTokens = extracted.completionTokens;
    }
  } catch {
    // JSON 解析失败不影响响应
  }

  if (config.protocol === "anthropic") {
    // OpenAI chat.completion → Anthropic message（回显下游请求的模型名）
    try {
      const converted = JSON.stringify(
        convertOpenAIResponse(JSON.parse(responseBody) as Record<string, unknown>, requestedModel)
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
          ttft: 0,
          duration: Date.now() - startTime,
          isError: false,
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
      // 转换失败（上游返回了意外的 JSON 结构）：不记成功日志，按 502 处理
      return liteErrorResponse(config, 502, "上游响应格式无法转换", "upstream_error");
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
      ttft: 0,
      duration: Date.now() - startTime,
      isError: false,
      db: env.DB,
      env: workerEnv,
    }).catch((logError) => {
      console.error("[proxy-lite] 日志写入失败:", logError);
    })
  );

  return new Response(responseBody, {
    status: upstreamResponse.status,
    headers: { "Content-Type": responseContentType },
  });
}
