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
import { extractForwardableHeaders } from "./forward-headers";
import { loadTemplates, getApplicableTemplates, applyTemplates } from "./request-templates";
import type { ApiKeyRecord } from "./auth";
import type { WorkerEnv } from "./config";

// ==================== SSRF 防护 ====================

/** 内网地址正则匹配 */
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^127\./,
  /^0\./,
];

/**
 * 校验上游 URL 是否安全（防 SSRF）
 * 仅允许 http/https 协议，禁止内网地址
 */
function isSafeUpstreamUrl(urlStr: string): { safe: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { safe: false, reason: "URL 格式不合法" };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { safe: false, reason: "URL 协议必须是 http 或 https" };
  }
  const hostname = url.hostname;
  if (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    PRIVATE_IP_PATTERNS.some((p) => p.test(hostname)) ||
    hostname === "[::1]" ||
    hostname === "::1"
  ) {
    return { safe: false, reason: "URL 不能指向内网或本地地址" };
  }
  return { safe: true };
}

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

// ==================== 流式空闲超时 ====================

/**
 * 空闲超时保护流：距上一次收到数据超过 idleMs 时终止流（流式响应专用）
 *
 * 与 fetch 的总超时不同：持续传输数据的正常长流不受影响，
 * 只有"上游挂起不吐数据"（如免费模型排队空转、连接半开）才会被切断，
 * 避免函数被无数据流无限占用（此前实测挂起可达 15 分钟）。
 *
 * @param onTimeout 超时回调（用于补记请求日志；输入流正常结束时不会触发）
 */
export function withIdleTimeout(
  stream: ReadableStream<Uint8Array>,
  idleMs: number,
  onTimeout?: () => void
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const armTimer = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    clearTimer();
    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      onTimeout?.();
      // 取消上游读取、释放上游连接（与 Pages 版看门狗 r.cancel() 行为对齐）；
      // pending read 会 reject 进入 start 的 catch，那里已做二次 error 防重入
      reader.cancel().catch(() => {});
      controller.error(new DOMException("上游响应空闲超时", "TimeoutError"));
    }, idleMs);
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      armTimer(controller);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            finished = true;
            clearTimer();
            controller.close();
            break;
          }
          armTimer(controller);
          controller.enqueue(value);
        }
      } catch (err) {
        finished = true;
        clearTimer();
        try {
          controller.error(err);
        } catch {
          // 超时路径已主动 error（reader.cancel 导致的 read reject），忽略二次 error
        }
      }
    },
    cancel(reason) {
      finished = true;
      clearTimer();
      return reader.cancel(reason);
    },
  });
}

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
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> {
  const startTime = Date.now();
  const logTag = `[v1-proxy:${config.upstreamPath}]`;

  // 提取 WorkerEnv 部分，供内部函数调用（避免 { DB, KV } & WorkerEnv 赋值给 WorkerEnv 的类型错误）
  const workerEnv: WorkerEnv = { DB_TYPE: env.DB_TYPE };

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
    ? await routeRequest(modelName, env.DB, workerEnv)
    : await routeRequest("__any__", env.DB, workerEnv);

  if (!route) {
    return Response.json(
      { error: { message: "此模型不存在", type: "server_error" } },
      { status: 500 }
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

  // ── 5. 上游错误自动重试（429/401/403：同平台换 Key → 换平台，最多 3 次）──
  const MAX_UPSTREAM_RETRIES = 3;
  const isStream = config.supportsStreaming !== false && body.stream === true;
  const requestModel = requestedModel;

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
      return Response.json(
        {
          error: {
            message: "所有平台均无可用 API Key",
            type: "server_error",
          },
        },
        { status: 500 }
      );
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
      return Response.json(
        {
          error: {
            message: `平台 "${currentPlatform.name}" 无可用 API Key`,
            type: "server_error",
          },
        },
        { status: 500 }
      );
    }

    // 构建上游请求体
    let upstreamBody = config.buildUpstreamBody
      ? config.buildUpstreamBody(body)
      : { ...body, model: currentTargetModel };

    // 应用请求模板
    try {
      const templates = await loadTemplates(env.DB, workerEnv);
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
      return Response.json(
        { error: { message: `上游 URL 不安全: ${urlCheck.reason}`, type: "invalid_request_error" } },
        { status: 400 }
      );
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
      });
    } catch (fetchError) {
      clearTimeout(upstreamTimeoutId);
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

    // ── 2xx 成功响应：正常处理（流式/非流式）──
    // 上游返回空响应（2xx + 空 body/空流）时 handleUpstreamResponse 返回哨兵，
    // 判定为无效，与 429/401/403 一样纳入重试（封禁当前 Key → 换 Key → 换平台）
    let isEmptyResponse = false;
    if (upstreamResponse.status < 400) {
      const handled = await handleUpstreamResponse(
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
        estimatedTokens,
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

    const errorBody = sanitizeUpstreamError(errorText, upstreamResponse.status);
    return new Response(errorBody, {
      status: upstreamResponse.status,
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
 *
 * @param upstreamController 上游请求的 AbortController（signal 保护非流式响应体读取）
 * @param upstreamTimeoutId  上游请求总超时定时器（流式分支由空闲超时接管后清理）
 * @returns 正常响应，或 EMPTY_UPSTREAM_RESPONSE 哨兵（2xx 但响应体为空，交由调用方重试）
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
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext,
  maxTokensEstimate: number,
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
      return Response.json(
        { error: { message: "上游未返回流式响应", type: "server_error" } },
        { status: 500 }
      );
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
        return Response.json(
          {
            error: {
              message: "上游响应读取超时（2 分钟），请稍后重试",
              type: "timeout_error",
            },
          },
          { status: 504 }
        );
      }
      console.error(`${logTag} 流式响应首块读取失败:`, readError);
      await recordFailure(platform.id, env.DB);
      return Response.json(
        { error: { message: "读取上游响应失败", type: "server_error" } },
        { status: 500 }
      );
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
        return streamReader.read().then(({ done, value }) => {
          if (done) {
            controller.close();
          } else {
            controller.enqueue(value);
          }
        });
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
      kv: env.KV,
      db: env.DB,
      ctx,
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
    await recordSuccess(platform.id, env.DB);

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

  // multipart 响应（audio/images）直接透传（同样受空闲超时保护）
  if (responseContentType.includes("multipart/")) {
    const multipartBody = upstreamResponse.body;
    if (!multipartBody) {
      clearTimeout(upstreamTimeoutId);
      return Response.json(
        { error: { message: "上游未返回响应体", type: "server_error" } },
        { status: 500 }
      );
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
        return Response.json(
          {
            error: {
              message: "上游响应读取超时（2 分钟），请稍后重试",
              type: "timeout_error",
            },
          },
          { status: 504 }
        );
      }
      await recordFailure(platform.id, env.DB);
      return Response.json(
        { error: { message: "读取上游响应失败", type: "server_error" } },
        { status: 500 }
      );
    }
    if (firstMultipart.done) {
      clearTimeout(upstreamTimeoutId);
      multipartReader.releaseLock();
      return EMPTY_UPSTREAM_RESPONSE;
    }

    clearTimeout(upstreamTimeoutId);
    await recordSuccess(platform.id, env.DB);

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
        env: workerEnv,
      });
    } catch (logError) {
      console.error(`${logTag} 日志写入失败:`, logError);
    }

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
      return Response.json(
        {
          error: {
            message: "上游响应读取超时（2 分钟），请稍后重试",
            type: "timeout_error",
          },
        },
        { status: 504 }
      );
    }
    await recordFailure(platform.id, env.DB);
    return Response.json(
      { error: { message: "读取上游响应失败", type: "server_error" } },
      { status: 500 }
    );
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
        await updateKeyUsage(apiKey.id, extracted.totalTokens, env.DB, workerEnv);
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
      env: workerEnv,
    });
  } catch (logError) {
    console.error(`${logTag} 日志写入失败:`, logError);
  }

  await recordSuccess(platform.id, env.DB);

  return new Response(responseBody, {
    status: upstreamResponse.status,
    headers: { "Content-Type": "application/json" },
  });
}
