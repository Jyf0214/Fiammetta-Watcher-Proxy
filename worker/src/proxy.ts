/**
 * 上游代理处理器
 *
 * 将下游请求转发到上游平台，支持：
 * - 流式响应（SSE TransformStream）
 * - 非流式响应（JSON 透传）
 * - 错误脱敏
 * - 熔断器状态记录
 * - 请求日志和 token 统计
 */

import { routeRequest, freezeAutoModel, isAutoModelRequest, getPlatformsForModel } from "./router";
import { getNextKey, getRandomKeyExcept, banKey, getAllKeys, isKeyBanned, isKeyDeprioritized, isKeyWhitelisted } from "./platform-keys";
import { recordSuccess, recordFailure } from "./load-balancer";
import { keyFingerprint } from "@/lib/key-status";
import {
  checkPlatformRpm,
  checkPlatformTpm,
  checkApiKeyRpm,
  checkApiKeyTpm,
} from "./rate-limiter";
import { createUsageTransformer, recordRequestLog } from "./token";
import { withIdleTimeout } from "./stream-guard";
import type { ProxyConfig } from "./endpoints";
import { extractForwardableHeaders } from "./forward-headers";
import { loadTemplates, getApplicableTemplates, applyTemplates } from "./request-templates";
import { isSafeUpstreamUrl } from "@/lib/ssrf";
import {
  convertOpenAIResponse,
  OpenAIToAnthropicStream,
  formatAnthropicError,
  AnthropicRequestError,
  estimateInputTokens,
} from "@/lib/anthropic";
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
function v1ErrorResponse(
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

// ==================== 流式空闲超时 ====================
// withIdleTimeout 已移至 stream-guard.ts（lite 版 Worker 共用），此处 re-export 保持兼容

export { withIdleTimeout };

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
 * handleUpstreamResponse 检测到后返回此哨兵，调用方将其判定为无效并纳入重试
 * （封禁当前 Key → 换 Key → 换平台），耗尽后返回 502 明确错误，绝不透传空响应。
 */
const EMPTY_UPSTREAM_RESPONSE = Symbol("empty-upstream-response");

// ==================== 请求体解析 ====================

const MAX_BODY_BYTES = 10 * 1024 * 1024;

async function parseRequestBody<T>(
  request: Request
): Promise<{ body: T } | { error: Response }> {
  // 优先用 Content-Length 头快速拒绝超大请求，避免读取整个 body
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return {
      error: Response.json(
        { error: { message: "请求体过大", type: "invalid_request_error" } },
        { status: 413 }
      ),
    };
  }

  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return {
      error: Response.json(
        { error: { message: "读取请求体失败", type: "invalid_request_error" } },
        { status: 400 }
      ),
    };
  }

  // Content-Length 不存在或不准时，用字符串长度兜底（中文等多字节会略小，但足够做限制）
  if (bodyText.length > MAX_BODY_BYTES) {
    return {
      error: Response.json(
        { error: { message: "请求体过大", type: "invalid_request_error" } },
        { status: 413 }
      ),
    };
  }

  let body: T;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      error: Response.json(
        { error: { message: "请求体格式错误", type: "invalid_request_error" } },
        { status: 400 }
      ),
    };
  }

  return { body };
}

// ==================== 统一代理入口 ====================
// ProxyConfig 类型已移至 endpoints.ts（lite 版 Worker 共用），此处 re-export 保持兼容

export type { ProxyConfig } from "./endpoints";

/**
 * 处理一个 V1 代理请求
 */
export async function proxyV1Request(
  request: Request,
  config: ProxyConfig,
  apiKey: ApiKeyRecord,
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const startTime = Date.now();
  const logTag = `[v1-proxy:${config.upstreamPath}]`;

  // 提取 WorkerEnv 部分，供内部函数调用（避免 { DB, KV } & WorkerEnv 赋值给 WorkerEnv 的类型错误）
  const workerEnv: WorkerEnv = { DB_TYPE: env.DB_TYPE };

  // ── 1. 解析请求体 ──
  const parseResult = await parseRequestBody<Record<string, unknown>>(request);
  if ("error" in parseResult) {
    // 请求体解析错误（413 过大 / 400 读取失败或 JSON 格式错误）按协议格式化：
    // Anthropic 分支需要 {type:"error",error:{type,message}}，OpenAI 分支保持原错误形状
    const errRes = parseResult.error;
    const errBody = (await errRes.json().catch(() => ({}))) as { error?: { message?: string } };
    return v1ErrorResponse(config, errRes.status, errBody?.error?.message || "请求体解析失败", "invalid_request_error");
  }
  const rawBody = parseResult.body;
  let body = rawBody;

  // ── 2. 额外校验 ──
  if (config.validateBody) {
    const validationError = config.validateBody(body);
    if (validationError) return validationError;
  }

  // ── 2.5 Anthropic 协议：下游 /v1/messages 请求体 → OpenAI /chat/completions 请求体 ──
  // 转换后 model/max_tokens/stream 字段名与语义对齐，后续路由/限流/重试管道原样复用
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

  // ── 3. 路由选择 ──
  const modelName = body.model as string | undefined;
  const requestedModel = modelName || "unknown";
  const route = modelName
    ? await routeRequest(modelName, env.DB, workerEnv)
    : await routeRequest("__any__", env.DB, workerEnv);

  if (!route) {
    // 路由失败（模型不存在/无平台支持）：platformId 未知记 null，补全请求失败记录
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
      console.error(`${logTag} 日志写入失败:`, logError);
    }
    return v1ErrorResponse(config, 500, "此模型不存在", "server_error");
  }

  // ── 4. 速率限制检查（本地限制，不重试）──
  const platformRpm = await checkPlatformRpm(
    route.platform.id,
    route.platform.rpmLimit,
    env.KV
  );
  if (!platformRpm.allowed) {
    // 平台级限流反映平台过载/配额耗尽，计入该平台错误统计（Key 级限流是客户端行为，不记录避免污染平台评分）
    try {
      await recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: route.platform.id,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status: 429,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: true,
        errorMessage: "上游平台请求频率超限",
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error(`${logTag} 日志写入失败:`, logError);
    }
    return v1ErrorResponse(config, 429, "上游平台请求频率超限", "rate_limit_error", {
      retry_after: Math.ceil((platformRpm.resetAt - Date.now()) / 1000),
    });
  }

  const keyRpm = await checkApiKeyRpm(
    apiKey.id,
    apiKey.rpmLimit,
    env.KV
  );
  if (!keyRpm.allowed) {
    return v1ErrorResponse(config, 429, "API Key 请求频率超限", "rate_limit_error", {
      retry_after: Math.ceil((keyRpm.resetAt - Date.now()) / 1000),
    });
  }

  // TPM 检查：用请求体中的 max_tokens 作为预估 token 数
  const estimatedTokens = Math.max(
    1,
    Number(body.max_tokens || body.max_completion_tokens) || 1
  );
  // Anthropic 转换器的 message_start.usage.input_tokens：用转换前请求体的输入估算
  // （max_tokens 是输出上限，语义不符；仅限流 TPM 继续用 estimatedTokens）
  const anthropicInputEstimate =
    config.protocol === "anthropic" ? estimateInputTokens(rawBody) : estimatedTokens;

  const platformTpm = await checkPlatformTpm(
    route.platform.id,
    route.platform.tpmLimit,
    estimatedTokens,
    env.KV
  );
  if (!platformTpm.allowed) {
    // 平台级 TPM 限流计入该平台错误统计（与平台 RPM 一致；Key 级不记录）
    try {
      await recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: route.platform.id,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status: 429,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: true,
        errorMessage: "上游平台 Token 速率超限",
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error(`${logTag} 日志写入失败:`, logError);
    }
    return v1ErrorResponse(config, 429, "上游平台 Token 速率超限", "rate_limit_error", {
      retry_after: Math.ceil((platformTpm.resetAt - Date.now()) / 1000),
    });
  }

  const keyTpm = await checkApiKeyTpm(
    apiKey.id,
    apiKey.tpmLimit,
    estimatedTokens,
    env.KV
  );
  if (!keyTpm.allowed) {
    return v1ErrorResponse(config, 429, "API Key Token 速率超限", "rate_limit_error", {
      retry_after: Math.ceil((keyTpm.resetAt - Date.now()) / 1000),
    });
  }

  // ── 5. 上游错误自动重试（429/401/403：同平台换 Key → 换平台，最多 3 次）──
  const MAX_UPSTREAM_RETRIES = 3;
  const isStream = config.supportsStreaming !== false && body.stream === true;

  let currentPlatform = route.platform;
  const currentTargetModel = route.targetModel;
  let currentKey = getNextKey(currentPlatform);
  const triedKeys = new Set<string>();
  const triedPlatforms = new Set<string>();

  // 如果初始平台没有可用 Key，尝试切换到其他有可用 Key 的平台
  if (!currentKey) {
    const allKeys = getAllKeys(currentPlatform);
    console.warn(
      `${logTag} 初始平台 "${currentPlatform.name}" (${currentPlatform.id}) 无可用 Key` +
      `（共 ${allKeys.length} 个 Key，封禁: ${allKeys.filter((k) => isKeyBanned(k, currentPlatform.id)).length}` +
      `，降级: ${allKeys.filter((k) => isKeyDeprioritized(k, currentPlatform.id)).length}` +
      `，白名单: ${allKeys.filter(isKeyWhitelisted).length}）` +
      `，尝试切换到其他平台`
    );
    triedPlatforms.add(currentPlatform.id);

    const availablePlatforms = getPlatformsForModel(
      currentTargetModel,
      triedPlatforms
    );
    let switched = false;
    for (const p of availablePlatforms) {
      const key = getNextKey(p);
      if (key) {
        currentPlatform = p;
        currentKey = key;
        switched = true;
        console.log(`${logTag} 已切换到平台 "${p.name}" (${p.id})`);
        break;
      }
    }

    if (!switched) {
      console.error(
        `${logTag} 所有平台均无可用 Key，` +
        `已检查 ${availablePlatforms.length + 1} 个平台`
      );
      // 全部平台无可用 Key：平台维度未知记 null（配置问题，不计入任何平台评分）
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
          errorMessage: "所有平台均无可用 API Key",
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error(`${logTag} 日志写入失败:`, logError);
      }
      return v1ErrorResponse(config, 500, "所有平台均无可用 API Key", "server_error");
    }
  }

  for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt++) {
    // 记录本次尝试的 Key 和平台
    if (currentKey) triedKeys.add(currentKey);
    triedPlatforms.add(currentPlatform.id);

    // 无可用 Key
    if (!currentKey) {
      const platformKeys = getAllKeys(currentPlatform);
      console.error(
        `${logTag} 平台 "${currentPlatform.name}" (${currentPlatform.id}) ` +
        `已无可用 Key（共 ${platformKeys.length} 个，` +
        `已尝试: ${triedKeys.size}，` +
        `封禁: ${platformKeys.filter((k) => isKeyBanned(k, currentPlatform.id)).length}，` +
        `降级: ${platformKeys.filter((k) => isKeyDeprioritized(k, currentPlatform.id)).length}）`
      );
      // 当前平台 Key 耗尽（同平台换 Key 失败）：计入该平台错误统计
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: currentPlatform.id,
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
          errorMessage: `平台 "${currentPlatform.name}" 无可用 API Key`,
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error(`${logTag} 日志写入失败:`, logError);
      }
      return v1ErrorResponse(config, 500, `平台 "${currentPlatform.name}" 无可用 API Key`, "server_error");
    }

    // 构建上游请求体（Anthropic 分支的请求体已在步骤 2.5 转换为 OpenAI 格式）
    let upstreamBody: Record<string, unknown> = { ...body, model: currentTargetModel };

    // 应用请求模板
    try {
      const templates = await loadTemplates(env.DB, workerEnv);
      const applicable = getApplicableTemplates(templates, requestedModel);
      if (applicable.length > 0) {
        upstreamBody = applyTemplates(upstreamBody, applicable);
      }
    } catch (tplErr) {
      console.error(`${logTag} 加载请求模板失败:`, tplErr);
    }

    // 流式请求注入 stream_options
    if (isStream) {
      upstreamBody.stream_options = { include_usage: true };
    }

    // 解析透传头（只保留合法 header 名，Workers fetch 对非法名会抛 TypeError）
    const rawForwardHeaders = extractForwardableHeaders(
      request.headers,
      currentPlatform.forwardHeaders
    );
    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawForwardHeaders)) {
      if (/^[a-zA-Z0-9-]+$/.test(k)) {
        forwardHeaders[k] = v;
      }
    }

    const upstreamUrl = `${currentPlatform.baseUrl.replace(/\/+$/, "")}${config.upstreamPath}`;

    // SSRF 防护：校验上游 URL
    const urlCheck = isSafeUpstreamUrl(currentPlatform.baseUrl);
    if (!urlCheck.safe) {
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: currentPlatform.id,
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
        console.error(`${logTag} 日志写入失败:`, logError);
      }
      return v1ErrorResponse(config, 400, `上游 URL 不安全: ${urlCheck.reason}`, "invalid_request_error");
    }

    // 发送上游请求
    // 注意：fetch resolve 后不立即 clearTimeout，signal 继续保护后续响应体读取；
    // 各分支（流式/非流式/错误）按需清理。
    let upstreamResponse: Response;
    const upstreamController = new AbortController();
    const upstreamTimeoutId = setTimeout(
      () => upstreamController.abort(),
      UPSTREAM_TIMEOUT_MS
    );
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
        return v1ErrorResponse(config, 504, "上游请求超时（2 分钟），请稍后重试", "timeout_error");
      }
      throw fetchError;
    }

    // ── 2xx 成功响应：正常处理（流式/非流式）──
    // 上游返回空响应（2xx + 空 body/空流）时 handleUpstreamResponse 返回哨兵，
    // 判定为无效，与 429/401/403 一样纳入重试（封禁当前 Key → 换 Key → 换平台）
    // 注意：redirect:"manual" 后 3xx 不再进入此分支，落入下方不可重试分支透传
    let isEmptyResponse = false;
    if (upstreamResponse.status >= 200 && upstreamResponse.status < 300) {
      const handled = await handleUpstreamResponse(
        upstreamResponse,
        currentPlatform,
        apiKey,
        requestedModel,
        config,
        isStream,
        startTime,
        env,
        ctx,
        estimatedTokens,
        anthropicInputEstimate,
        logTag,
        upstreamController,
        upstreamTimeoutId
      );
      if (handled !== EMPTY_UPSTREAM_RESPONSE) return handled;
      isEmptyResponse = true;
    }

    // ── 5xx 等不可重试错误：真实透传状态码 + 熔断 + 错误日志 ──
    // 此前流式分支硬编码 200 透传任何非 429 状态，401/403/5xx 被伪装成成功，
    // 下游收到"200 + 空响应"，熔断器与 Key 封禁机制被完全架空。
    if (!isEmptyResponse && !RETRYABLE_UPSTREAM_STATUSES.has(upstreamResponse.status)) {
      let errorText = "";
      try {
        errorText = await upstreamResponse.text();
      } catch {
        // 读取错误体失败（如 signal 超时），保留空错误体
      }
      clearTimeout(upstreamTimeoutId);

      try {
        await recordFailure(currentPlatform.id, env.DB);
      } catch (recordError) {
        console.error(
          `${logTag} 熔断器记录失败:`,
          recordError instanceof Error ? recordError.message : String(recordError)
        );
      }

      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: currentPlatform.id,
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
          errorMessage: errorText.substring(0, 1000),
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error(`${logTag} 日志写入失败:`, logError);
      }

      if (config.protocol === "anthropic") {
        return Response.json(
          formatAnthropicError(upstreamResponse.status, extractUpstreamErrorMessage(errorText)),
          { status: upstreamResponse.status }
        );
      }
      return new Response(
        sanitizeUpstreamError(errorText, upstreamResponse.status),
        {
          status: upstreamResponse.status,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // ── 429/401/403/空响应：封禁当前 Key 并尝试切换 ──
    if (attempt < MAX_UPSTREAM_RETRIES) {
      // 本次尝试失败独立记日志：被重试覆盖的错误平台也必须进入平台错误统计，
      // 否则评分只见最终成功平台、错误率被严重低估
      try {
        await recordRequestLog({
          keyId: apiKey.id,
          keyName: apiKey.name,
          platformId: currentPlatform.id,
          model: requestedModel,
          endpoint: config.upstreamPath,
          method: "POST",
          status: isEmptyResponse ? 502 : upstreamResponse.status,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          ttft: 0,
          duration: Date.now() - startTime,
          isError: true,
          errorMessage: isEmptyResponse ? "上游返回空响应（重试切换）" : `上游 ${upstreamResponse.status}（已封禁该 Key 并重试切换）`,
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error(`${logTag} 日志写入失败:`, logError);
      }
      // 封禁该 Key 5 分钟（内存 + KV 持久化，管理后台可见）
      await banKey(currentKey, undefined, currentPlatform.id, env.KV);
      console.log(
        `${logTag} 上游 ${upstreamResponse.status}${isEmptyResponse ? "（空响应）" : ""} (平台: ${currentPlatform.name}, key: fingerprint:${keyFingerprint(currentKey)}, attempt: ${attempt + 1}/${MAX_UPSTREAM_RETRIES})，已封禁该 Key 5 分钟，尝试切换`
      );

      // 清理本次尝试的超时定时器，避免泄漏
      clearTimeout(upstreamTimeoutId);

      // 策略 1：同平台换 Key
      const nextKey = getRandomKeyExcept(currentPlatform, triedKeys);
      if (nextKey) {
        currentKey = nextKey;
        continue;
      }

      // 策略 2：换平台（支持同一模型）
      const otherPlatforms = getPlatformsForModel(
        currentTargetModel,
        triedPlatforms
      );
      if (otherPlatforms.length > 0) {
        const idx = Math.floor(Math.random() * otherPlatforms.length);
        currentPlatform = otherPlatforms[idx];
        currentKey = getNextKey(currentPlatform);
        continue;
      }

      // 无更多可切换的目标
      console.log(
        `${logTag} 已无更多可切换的平台/Key，返回最后的 ${upstreamResponse.status} 响应`
      );
    }

    // 最后一次尝试或无处可切换：返回真实状态
    let errorText = "";
    try {
      errorText = await upstreamResponse.text();
    } catch {
      // 读取错误体失败（如 signal 超时），保留空错误体
    }
    clearTimeout(upstreamTimeoutId);
    try {
      await recordFailure(currentPlatform.id, env.DB);
    } catch (recordError) {
      console.error(
        `${logTag} 熔断器记录失败:`,
        recordError instanceof Error ? recordError.message : String(recordError)
      );
    }

    try {
      // 日志 status 记录实际返回下游的状态：空响应耗尽时下游收到 502，
      // 不再记上游的 200（此前记上游实际状态导致管理后台显示"成功"）
      await recordRequestLog({
        keyId: apiKey.id,
        keyName: apiKey.name,
        platformId: currentPlatform.id,
        model: requestedModel,
        endpoint: config.upstreamPath,
        method: "POST",
        status: isEmptyResponse ? 502 : upstreamResponse.status,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: true,
        errorMessage: isEmptyResponse ? "上游返回空响应" : errorText.substring(0, 1000),
        db: env.DB,
        env: workerEnv,
      });
    } catch (logError) {
      console.error(`${logTag} 日志写入失败:`, logError);
    }

    // 自动模型冻结
    if (isAutoModelRequest(requestedModel)) {
      freezeAutoModel(requestedModel);
    }

    // 空响应特判：绝不向下游透传空响应，返回 502 + 明确错误
    if (isEmptyResponse) {
      if (config.protocol === "anthropic") {
        return Response.json(formatAnthropicError(502, "上游返回空响应，请求已重试仍无内容"), { status: 502 });
      }
      return new Response(
        JSON.stringify({
          error: {
            message: "上游返回空响应，请求已重试仍无内容",
            type: "upstream_error",
            upstream_status: upstreamResponse.status,
          },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
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

  // 不应到达此处，兜底返回
  return v1ErrorResponse(config, 503, "重试耗尽", "server_error");
}

// ==================== 上游响应处理 ====================

/**
 * OpenAI SSE → Anthropic SSE 的 TransformStream（Anthropic 协议分支专用）
 *
 * 接在 createUsageTransformer 之后：usage 提取/日志/截断检测仍作用于上游
 * OpenAI 流（语义不变），本转换器只把 OpenAI chunk 转成 Anthropic 事件
 * （message_start → content_block_* → message_delta → message_stop）
 */
function createAnthropicStreamTransformer(
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
          // 流内 error：Anthropic 客户端靠 event: error 感知失败（与 Pages 侧语义一致）
          if (parsed.error) {
            const rawCode = parsed.error.code;
            const code = typeof rawCode === "number" ? rawCode : typeof rawCode === "string" ? parseInt(rawCode, 10) : NaN;
            if (!Number.isNaN(code) && Number.isInteger(code) && code >= 400 && code <= 599) {
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
 * 处理上游成功响应（流式/非流式），记录日志和统计
 *
 * @param upstreamController 上游请求的 AbortController（signal 保护非流式响应体读取）
 * @param upstreamTimeoutId  上游请求总超时定时器（流式分支由空闲超时接管后清理）
 * @returns 正常响应，或 EMPTY_UPSTREAM_RESPONSE 哨兵（2xx 但响应体为空，交由调用方重试）
 */
async function handleUpstreamResponse(
  upstreamResponse: Response,
  platform: { id: string; name: string },
  apiKey: ApiKeyRecord,
  requestedModel: string,
  config: ProxyConfig,
  isStream: boolean,
  startTime: number,
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext,
  maxTokensEstimate: number,
  anthropicInputEstimate: number,
  logTag: string,
  upstreamController: AbortController,
  upstreamTimeoutId: ReturnType<typeof setTimeout>
): Promise<Response | typeof EMPTY_UPSTREAM_RESPONSE> {
  // 提取 WorkerEnv 部分，供内部函数调用
  const workerEnv: WorkerEnv = { DB_TYPE: env.DB_TYPE };
  // 流式响应（SSE）
  if (isStream) {
    const stream = upstreamResponse.body;
    if (!stream) {
      clearTimeout(upstreamTimeoutId);
      try {
        await recordFailure(platform.id, env.DB);
      } catch {
        console.error(`${logTag} 流式响应缺失时熔断器记录失败`);
      }
      return v1ErrorResponse(config, 500, "上游未返回流式响应", "server_error");
    }

    // 先读第一块判断是否为空流：200 + 空 SSE（首个 read 即 done）视为空响应，
    // 由调用方判定无效并重试；等待第一块仍受总超时（signal）保护
    const streamReader = stream.getReader();
    let firstChunk: ReadableStreamReadResult<Uint8Array>;
    try {
      firstChunk = await streamReader.read();
    } catch (readError) {
      clearTimeout(upstreamTimeoutId);
      if (upstreamController.signal.aborted) {
        return v1ErrorResponse(config, 504, "上游响应读取超时（2 分钟），请稍后重试", "timeout_error");
      }
      console.error(`${logTag} 流式响应首块读取失败:`, readError);
      await recordFailure(platform.id, env.DB);
      return v1ErrorResponse(config, 500, "读取上游响应失败", "server_error");
    }
    if (firstChunk.done) {
      clearTimeout(upstreamTimeoutId);
      streamReader.releaseLock();
      return EMPTY_UPSTREAM_RESPONSE;
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

    const transformer = createUsageTransformer({
      keyId: apiKey.id,
      keyName: apiKey.name,
      platformId: platform.id,
      model: requestedModel,
      startTime,
      db: env.DB,
      env: workerEnv,
    });

    // 空闲超时置于 transformer 之前，直接包装上游流：只有上游真正无数据时才切断，
    // 下游消费慢（背压）不会误判。上游流正常结束时 transformer flush 写日志；
    // 挂起超时时 transformer 输入被 error 不会 flush，由 onTimeout 补记超时错误日志。
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
            console.error(`${logTag} 空闲超时日志写入失败:`, logError);
          })
        );
      }
    );
    const pipedStream = guardedStream.pipeThrough(transformer);
    // Anthropic 协议：OpenAI SSE → Anthropic 事件流（在 usage 统计之后转换）
    const finalStream = config.protocol === "anthropic"
      ? pipedStream.pipeThrough(createAnthropicStreamTransformer(requestedModel, anthropicInputEstimate))
      : pipedStream;
    // 不阻塞首字节：recordSuccess 在 half-open 恢复时会写库（TiDB/远端 DB 可达秒级），
    // 若在返回 Response 前 await，客户端 TTFB 会被拖到秒级（实测 9.95s）
    ctx.waitUntil(recordSuccess(platform.id, env.DB).catch(() => {}));

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
      return v1ErrorResponse(config, 500, "上游未返回响应体", "server_error");
    }
    // 先读第一块判断是否为空：空 multipart 视为空响应，交由调用方重试；
    // 等待第一块仍受总超时（signal）保护
    const multipartReader = multipartBody.getReader();
    let firstMultipart: ReadableStreamReadResult<Uint8Array>;
    try {
      firstMultipart = await multipartReader.read();
    } catch {
      clearTimeout(upstreamTimeoutId);
      if (upstreamController.signal.aborted) {
        return v1ErrorResponse(config, 504, "上游响应读取超时（2 分钟），请稍后重试", "timeout_error");
      }
      await recordFailure(platform.id, env.DB);
      return v1ErrorResponse(config, 500, "读取上游响应失败", "server_error");
    }
    if (firstMultipart.done) {
      clearTimeout(upstreamTimeoutId);
      multipartReader.releaseLock();
      return EMPTY_UPSTREAM_RESPONSE;
    }

    clearTimeout(upstreamTimeoutId);
    // 不阻塞首字节：multipart 响应同样在返回 Response 前把写库后置到 waitUntil（与流式分支一致）
    ctx.waitUntil(recordSuccess(platform.id, env.DB).catch(() => {}));

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
        console.error(`${logTag} 日志写入失败:`, logError);
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
      return v1ErrorResponse(config, 504, "上游响应读取超时（2 分钟），请稍后重试", "timeout_error");
    }
    await recordFailure(platform.id, env.DB);
    return v1ErrorResponse(config, 500, "读取上游响应失败", "server_error");
  } finally {
    clearTimeout(upstreamTimeoutId);
  }

  // 空响应：2xx 但响应体为空（上游返回空 body），判定无效交由调用方重试
  if (!responseBody.trim()) {
    return EMPTY_UPSTREAM_RESPONSE;
  }

  // 提取 usage 并更新统计（传入 max_tokens 预估值防篡改）
  let responseTokens = 0;
  let responsePromptTokens = 0;
  let responseCompletionTokens = 0;

  try {
    const parsed = JSON.parse(responseBody);
    const usage = parsed?.usage;
    if (usage) {
      const { extractUsage } = await import("./token");
      const extracted = extractUsage(usage, maxTokensEstimate);

      responseTokens = extracted.totalTokens;
      responsePromptTokens = extracted.promptTokens;
      responseCompletionTokens = extracted.completionTokens;

      if (extracted.totalTokens > 0) {
        const { updateKeyUsage } = await import("./token");
        // 不阻塞响应：用量更新是独立写库，后置到 waitUntil（与流式分支一致）
        ctx.waitUntil(updateKeyUsage(apiKey.id, extracted.totalTokens, env.DB, workerEnv).catch(() => {}));
      }
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
      // 转换成功后才记成功日志/用量，避免转换失败时留下"200 成功"的误导记录
      // 不阻塞响应：成功日志/熔断记录后置到 waitUntil（与流式分支一致）
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
          console.error(`${logTag} 日志写入失败:`, logError);
        })
      );
      ctx.waitUntil(recordSuccess(platform.id, env.DB).catch(() => {}));
      return new Response(converted, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      try {
        await recordFailure(platform.id, env.DB);
      } catch {
        // 熔断记录失败不影响响应
      }
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
          db: env.DB,
          env: workerEnv,
        });
      } catch (logError) {
        console.error(`${logTag} 日志写入失败:`, logError);
      }
      return Response.json(formatAnthropicError(502, "上游响应格式错误"), { status: 502 });
    }
  }

  // 不阻塞响应：成功日志/熔断记录后置到 waitUntil（与流式分支一致）
  ctx.waitUntil(
    recordRequestLog({
      keyId: apiKey.id,
      keyName: apiKey.name,
      platformId: platform.id,
      model: requestedModel,
      endpoint: config.upstreamPath,
      method: "POST",
      status: upstreamResponse.status,
      tokens: responseTokens,
      promptTokens: responsePromptTokens,
      completionTokens: responseCompletionTokens,
      ttft: 0,
      duration: Date.now() - startTime,
      isError: false,
      db: env.DB,
      env: workerEnv,
    }).catch((logError) => {
      console.error(`${logTag} 日志写入失败:`, logError);
    })
  );

  ctx.waitUntil(recordSuccess(platform.id, env.DB).catch(() => {}));

  return new Response(responseBody, {
    status: upstreamResponse.status,
    headers: { "Content-Type": "application/json" },
  });
}
