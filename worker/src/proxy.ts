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
import { getNextKey, getRandomKeyExcept } from "./platform-keys";
import { recordSuccess, recordFailure } from "./load-balancer";
import {
  checkPlatformRpm,
  checkPlatformTpm,
  checkApiKeyRpm,
  checkApiKeyTpm,
} from "./rate-limiter";
import { createUsageTransformer, recordRequestLog } from "./token";
import { extractForwardableHeaders } from "./forward-headers";
import { loadTemplates, getApplicableTemplates, applyTemplates } from "./request-templates";
import type { ApiKeyRecord } from "./auth";

// ==================== 上游错误脱敏 ====================

/**
 * 脱敏上游错误响应，仅提取错误消息
 */
function sanitizeUpstreamError(errorText: string, upstreamStatus: number): string {
  try {
    const parsed = JSON.parse(errorText);
    const message =
      parsed?.error?.message || parsed?.message || parsed?.detail || "";
    return JSON.stringify({
      error: {
        message: String(message).substring(0, 500) || "上游服务返回错误",
        type: "upstream_error",
        upstream_status: upstreamStatus,
      },
    });
  } catch {
    return JSON.stringify({
      error: {
        message: "上游服务返回未知错误",
        type: "upstream_error",
        upstream_status: upstreamStatus,
      },
    });
  }
}

// ==================== 请求体解析 ====================

const MAX_BODY_BYTES = 10 * 1024 * 1024;

async function parseRequestBody<T>(
  request: Request
): Promise<{ body: T } | { error: Response }> {
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

  if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
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

// ==================== 速率限制检查 ====================

function _checkRateLimits(
  platform: { id: string; rpmLimit: number | null; tpmLimit: number | null },
  apiKey: ApiKeyRecord
): { allowed: true } | { error: Response } {
  // 平台级 RPM
  if (platform.rpmLimit !== null) {
    // 这里需要 KV，但静态检查不通过 KV（KV 是异步的）
    // 实际检查在 proxyV1Request 中通过 KV 完成
  }

  // Key 级调用次数检查
  const effectiveCallLimit = apiKey.callLimit ?? null;
  if (effectiveCallLimit !== null && apiKey.callUsed >= effectiveCallLimit) {
    return {
      error: Response.json(
        { error: { message: "API Key 调用次数已达上限", type: "invalid_request_error" } },
        { status: 429 }
      ),
    };
  }

  return { allowed: true };
}

// ==================== 统一代理入口 ====================

export interface ProxyConfig {
  /** 上游路径，如 "/chat/completions"、"/embeddings" */
  upstreamPath: string;
  /** 是否支持流式响应 */
  supportsStreaming?: boolean;
  /** 允许的模型类型 */
  allowedModelTypes?: string[];
  /** 额外的请求体校验 */
  validateBody?: (body: Record<string, unknown>) => Response | null;
  /** 构建上游请求体 */
  buildUpstreamBody?: (
    body: Record<string, unknown>
  ) => Record<string, unknown>;
}

/**
 * 处理一个 V1 代理请求
 */
export async function proxyV1Request(
  request: Request,
  config: ProxyConfig,
  apiKey: ApiKeyRecord,
  env: { DB: D1Database; KV: KVNamespace },
  ctx: ExecutionContext
): Promise<Response> {
  const startTime = Date.now();
  const logTag = `[v1-proxy:${config.upstreamPath}]`;

  // ── 1. 解析请求体 ──
  const parseResult = await parseRequestBody<Record<string, unknown>>(request);
  if ("error" in parseResult) return parseResult.error;
  const body = parseResult.body;

  // ── 2. 额外校验 ──
  if (config.validateBody) {
    const validationError = config.validateBody(body);
    if (validationError) return validationError;
  }

  // ── 3. 路由选择 ──
  const modelName = body.model as string | undefined;
  const requestedModel = modelName || "unknown";
  const route = modelName
    ? await routeRequest(modelName, env.DB)
    : await routeRequest("__any__", env.DB);

  if (!route) {
    return Response.json(
      { error: { message: "没有可用的上游平台", type: "server_error" } },
      { status: 503 }
    );
  }

  // ── 4. 速率限制检查（本地限制，不重试）──
  const platformRpm = await checkPlatformRpm(
    route.platform.id,
    route.platform.rpmLimit,
    env.KV
  );
  if (!platformRpm.allowed) {
    return Response.json(
      {
        error: {
          message: "上游平台请求频率超限",
          type: "rate_limit_error",
          retry_after: Math.ceil((platformRpm.resetAt - Date.now()) / 1000),
        },
      },
      { status: 429 }
    );
  }

  const keyRpm = await checkApiKeyRpm(
    apiKey.id,
    apiKey.rpmLimit,
    env.KV
  );
  if (!keyRpm.allowed) {
    return Response.json(
      {
        error: {
          message: "API Key 请求频率超限",
          type: "rate_limit_error",
          retry_after: Math.ceil((keyRpm.resetAt - Date.now()) / 1000),
        },
      },
      { status: 429 }
    );
  }

  // TPM 检查：用请求体中的 max_tokens 作为预估 token 数
  const estimatedTokens = Math.max(
    1,
    Number(body.max_tokens || body.max_completion_tokens) || 1
  );

  const platformTpm = await checkPlatformTpm(
    route.platform.id,
    route.platform.tpmLimit,
    estimatedTokens,
    env.KV
  );
  if (!platformTpm.allowed) {
    return Response.json(
      {
        error: {
          message: "上游平台 Token 速率超限",
          type: "rate_limit_error",
          retry_after: Math.ceil((platformTpm.resetAt - Date.now()) / 1000),
        },
      },
      { status: 429 }
    );
  }

  const keyTpm = await checkApiKeyTpm(
    apiKey.id,
    apiKey.tpmLimit,
    estimatedTokens,
    env.KV
  );
  if (!keyTpm.allowed) {
    return Response.json(
      {
        error: {
          message: "API Key Token 速率超限",
          type: "rate_limit_error",
          retry_after: Math.ceil((keyTpm.resetAt - Date.now()) / 1000),
        },
      },
      { status: 429 }
    );
  }

  // ── 5. 429 自动重试（同平台换 Key → 换平台，最多 3 次）──
  const MAX_429_RETRIES = 3;
  const isStream = config.supportsStreaming !== false && body.stream === true;
  const requestModel = requestedModel;

  let currentPlatform = route.platform;
  const currentTargetModel = route.targetModel;
  let currentKey = getNextKey(currentPlatform);
  const triedKeys = new Set<string>();
  const triedPlatforms = new Set<string>();

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    // 记录本次尝试的 Key 和平台
    if (currentKey) triedKeys.add(currentKey);
    triedPlatforms.add(currentPlatform.id);

    // 无可用 Key
    if (!currentKey) {
      return Response.json(
        { error: { message: "平台无可用 API Key", type: "server_error" } },
        { status: 500 }
      );
    }

    // 构建上游请求体
    let upstreamBody = config.buildUpstreamBody
      ? config.buildUpstreamBody(body)
      : { ...body, model: currentTargetModel };

    // 应用请求模板
    try {
      const templates = await loadTemplates(env.DB);
      const applicable = getApplicableTemplates(templates, requestModel);
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

    // 解析透传头
    const forwardHeaders = extractForwardableHeaders(
      request.headers,
      currentPlatform.forwardHeaders
    );

    const upstreamUrl = `${currentPlatform.baseUrl.replace(/\/+$/, "")}${config.upstreamPath}`;

    // 发送上游请求
    let upstreamResponse: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120_000);

      upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentKey}`,
          ...forwardHeaders,
        },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (fetchError) {
      if (
        fetchError instanceof DOMException &&
        fetchError.name === "AbortError"
      ) {
        return Response.json(
          {
            error: {
              message: "上游请求超时（2 分钟），请稍后重试",
              type: "timeout_error",
            },
          },
          { status: 504 }
        );
      }
      throw fetchError;
    }

    // ── 非 429 响应：直接返回 ──
    if (upstreamResponse.status !== 429) {
      return await handleUpstreamResponse(
        upstreamResponse,
        currentPlatform,
        currentKey,
        apiKey,
        requestModel,
        config,
        isStream,
        startTime,
        env,
        ctx,
        logTag
      );
    }

    // ── 429 响应：尝试切换 ──
    if (attempt < MAX_429_RETRIES) {
      console.log(
        `${logTag} 上游 429 (平台: ${currentPlatform.name}, key: ${currentKey.slice(0, 8)}..., attempt: ${attempt + 1}/${MAX_429_RETRIES})，尝试切换`
      );

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
        `${logTag} 已无更多可切换的平台/Key，返回最后的 429 响应`
      );
    }

    // 最后一次尝试或无处可切换：返回 429
    const errorText = await upstreamResponse.text();
    try {
      await recordFailure(currentPlatform.id);
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
        status: 429,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: true,
        errorMessage: errorText.substring(0, 1000),
        db: env.DB,
      });
    } catch (logError) {
      console.error(`${logTag} 日志写入失败:`, logError);
    }

    // 自动模型冻结
    if (isAutoModelRequest(requestedModel)) {
      freezeAutoModel(requestedModel);
    }

    const errorBody = sanitizeUpstreamError(errorText, 429);
    return new Response(errorBody, {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 不应到达此处，兜底返回
  return Response.json(
    { error: { message: "重试耗尽", type: "server_error" } },
    { status: 503 }
  );
}

// ==================== 上游响应处理 ====================

/**
 * 处理上游成功响应（流式/非流式），记录日志和统计
 */
async function handleUpstreamResponse(
  upstreamResponse: Response,
  platform: { id: string; name: string },
  upstreamKey: string,
  apiKey: ApiKeyRecord,
  requestedModel: string,
  config: ProxyConfig,
  isStream: boolean,
  startTime: number,
  env: { DB: D1Database; KV: KVNamespace },
  ctx: ExecutionContext,
  logTag: string
): Promise<Response> {
  // 流式响应（SSE）
  if (isStream) {
    const stream = upstreamResponse.body;
    if (!stream) {
      try {
        await recordFailure(platform.id);
      } catch {
        console.error(`${logTag} 流式响应缺失时熔断器记录失败`);
      }
      return Response.json(
        { error: { message: "上游未返回流式响应", type: "server_error" } },
        { status: 500 }
      );
    }

    const transformer = createUsageTransformer({
      keyId: apiKey.id,
      keyName: apiKey.name,
      platformId: platform.id,
      model: requestedModel,
      startTime,
      kv: env.KV,
      db: env.DB,
      ctx,
    });

    const pipedStream = stream.pipeThrough(transformer);
    await recordSuccess(platform.id);

    return new Response(pipedStream, {
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

  // multipart 响应（audio/images）直接透传
  if (responseContentType.includes("multipart/")) {
    await recordSuccess(platform.id);

    try {
      await recordRequestLog({
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
      });
    } catch (logError) {
      console.error(`${logTag} 日志写入失败:`, logError);
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: { "Content-Type": responseContentType },
    });
  }

  // JSON 响应
  let responseBody: string;
  try {
    responseBody = await upstreamResponse.text();
  } catch {
    await recordFailure(platform.id);
    return Response.json(
      { error: { message: "读取上游响应失败", type: "server_error" } },
      { status: 500 }
    );
  }

  // 提取 usage 并更新统计
  let responseTokens = 0;
  let responsePromptTokens = 0;
  let responseCompletionTokens = 0;

  try {
    const parsed = JSON.parse(responseBody);
    const usage = parsed?.usage;
    if (usage) {
      let promptTokens = Number(usage.prompt_tokens) || 0;
      let completionTokens = Number(usage.completion_tokens) || 0;
      const totalTokens =
        Number(usage.total_tokens) || promptTokens + completionTokens;

      if (totalTokens > 0 && promptTokens === 0 && completionTokens === 0) {
        promptTokens = totalTokens;
        completionTokens = totalTokens;
      }

      responseTokens = totalTokens;
      responsePromptTokens = promptTokens;
      responseCompletionTokens = completionTokens;

      if (totalTokens > 0) {
        const { updateKeyUsage } = await import("./token");
        await updateKeyUsage(apiKey.id, totalTokens, env.DB);
      }
    }
  } catch {
    // JSON 解析失败不影响响应
  }

  try {
    await recordRequestLog({
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
    });
  } catch (logError) {
    console.error(`${logTag} 日志写入失败:`, logError);
  }

  await recordSuccess(platform.id);

  return new Response(responseBody, {
    status: upstreamResponse.status,
    headers: { "Content-Type": "application/json" },
  });
}
