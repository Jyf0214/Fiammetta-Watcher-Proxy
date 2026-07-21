/**
 * POST /v1/audio/speech, /v1/audio/transcriptions, /v1/audio/translations — 音频代理接口
 *
 * 支持 JSON（speech）和 multipart/form-data（transcriptions/translations）两种请求格式。
 * 从原 Next.js Route Handler 迁移到 Hono。
 */

import type { Context } from "hono";
import type { Env } from "../../types";
import { createDb } from "../../db";
import { validateApiKey } from "../../lib/auth";
import { routeRequest } from "../../lib/router";
import { getNextKey } from "../../lib/platform-keys";
import { extractForwardableHeaders } from "../../lib/forward-headers";
import { checkPlatformRateLimit, checkKeyRateLimit } from "../../lib/rate-limiter";
import { detectModelType, MODEL_TYPE_NAMES } from "../../lib/model-type";
import type { ModelType } from "../../lib/model-type";
import { recordSuccess, recordFailure } from "../../lib/circuit-breaker";
import { sanitizeUpstreamError } from "../../lib/proxy-handler";
import { requestLogs } from "../../db/schema";

interface AudioSpeechRequest {
  model: string;
  input: string;
  voice: string;
  response_format?: string;
  speed?: number;
}

/**
 * 根据请求 URL 判断具体的音频子端点路径
 */
function getAudioPath(url: string): string {
  if (url.includes("/audio/speech")) return "/audio/speech";
  if (url.includes("/audio/transcriptions")) return "/audio/transcriptions";
  if (url.includes("/audio/translations")) return "/audio/translations";
  return "/audio/speech";
}

export async function audio(c: Context<{ Bindings: Env }>) {
  const startTime = Date.now();
  const db = createDb(c.env.DB);

  // 1. 验证 API Key
  const authHeader = c.req.header("authorization");
  const authResult = await validateApiKey(db, c.env, authHeader ?? null);
  if ("error" in authResult) return authResult.error;
  const { apiKey } = authResult;

  // 2. 判断请求类型（JSON 还是 multipart/form-data）
  const contentType = c.req.header("content-type") || "";
  const isMultipart = contentType.includes("multipart/form-data");

  if (isMultipart) {
    return handleMultipartAudio(c, db, apiKey, startTime);
  }
  return handleJsonAudio(c, db, apiKey, startTime);
}

/**
 * 处理 JSON 格式的音频请求（/v1/audio/speech）
 */
async function handleJsonAudio(
  c: Context<{ Bindings: Env }>,
  db: ReturnType<typeof createDb>,
  apiKey: { id: string; rpmLimit?: number | null; tpmLimit?: number | null; plan?: { rpmLimit?: number; tpmLimit?: number } | null },
  startTime: number
) {
  // 解析请求体
  let bodyText: string;
  try {
    bodyText = await c.req.text();
  } catch {
    return c.json(
      { error: { message: "读取请求体失败", type: "invalid_request_error" } },
      400
    );
  }

  if (new TextEncoder().encode(bodyText).byteLength > 10 * 1024 * 1024) {
    return c.json(
      { error: { message: "请求体过大", type: "invalid_request_error" } },
      413
    );
  }

  let body: AudioSpeechRequest;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return c.json(
      { error: { message: "请求体格式错误", type: "invalid_request_error" } },
      400
    );
  }

  if (!body.model) {
    return c.json(
      { error: { message: "缺少必要的 model 参数", type: "invalid_request_error" } },
      400
    );
  }

  // 3. 路由选择
  const route = await routeRequest(c.env, body.model);
  if (!route) {
    return c.json(
      { error: { message: "没有可用的上游平台", type: "server_error" } },
      503
    );
  }

  // 3.1 模型类型校验 — 仅允许 audio 类型
  const allowedModelTypes: ModelType[] = ["audio"];
  const modelType = detectModelType(body.model);
  if (!allowedModelTypes.includes(modelType)) {
    const allowedNames = allowedModelTypes.map(t => MODEL_TYPE_NAMES[t]).join("、");
    return c.json({
      error: {
        message: `模型 '${body.model}' 是${MODEL_TYPE_NAMES[modelType]}模型，不支持此端点。请使用对应类型的端点（支持：${allowedNames}）`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_supported",
      }
    }, 400);
  }

  // 4. 速率限制检查
  const rateResult = await checkPlatformRateLimit(
    c.env, route.platform.id, route.platform.rpmLimit, route.platform.tpmLimit
  );
  if (!rateResult.allowed) {
    return c.json(
      { error: { message: "请求速率超过限制，请稍后重试", type: "rate_limit_error" } },
      429,
      { "X-RateLimit-Reset": String(Math.ceil(rateResult.resetAt / 1000)) }
    );
  }

  // 4.1 API Key 级速率限制
  const effectiveRpmLimit = apiKey.rpmLimit ?? apiKey.plan?.rpmLimit ?? null;
  const effectiveTpmLimit = apiKey.tpmLimit ?? apiKey.plan?.tpmLimit ?? null;
  const apiKeyRateResult = await checkKeyRateLimit(c.env, apiKey.id, effectiveRpmLimit, effectiveTpmLimit);
  if (!apiKeyRateResult.allowed) {
    return c.json(
      { error: { message: "API Key 请求速率超过限制，请稍后重试", type: "rate_limit_error" } },
      429,
      { "X-RateLimit-Reset": String(Math.ceil(apiKeyRateResult.resetAt / 1000)) }
    );
  }

  // 5. 转发请求到上游
  const audioPath = getAudioPath(c.req.url);
  const upstreamUrl = `${route.platform.baseUrl}${audioPath}`;
  const upstreamKey = await getNextKey(c.env, { ...route.platform, apiKeys: JSON.stringify(route.platform.apiKeys) });
  if (!upstreamKey) {
    return c.json(
      { error: { message: "平台没有可用的 API Key", type: "server_error" } },
      503
    );
  }

  const forwardedHeaders = extractForwardableHeaders(
    c.req.raw, route.platform.forwardHeaders
  );

  let upstreamSucceeded = false;

  try {
    const upstreamBody = {
      ...body,
      model: route.targetModel,
    };

    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
        ...forwardedHeaders,
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(300_000),
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      await recordFailure(c.env, route.platform.id);
      upstreamSucceeded = false;

      // 记录错误日志
      const duration = Date.now() - startTime;
      await db.insert(requestLogs).values({
        id: crypto.randomUUID(),
        keyId: apiKey.id,
        platformId: route.platform.id,
        model: body.model,
        status: upstreamResponse.status,
        tokens: 0,
        duration,
        isError: true,
        errorMessage: errorText.substring(0, 1000),
        createdAt: new Date().toISOString(),
      }).catch(() => {});

      const errorBody = sanitizeUpstreamError(errorText, upstreamResponse.status);
      return new Response(errorBody, {
        status: upstreamResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // audio/speech 返回音频流
    upstreamSucceeded = true;
    await recordSuccess(c.env, route.platform.id);

    // 记录成功日志（无 token 扣减）
    const duration = Date.now() - startTime;
    await db.insert(requestLogs).values({
      id: crypto.randomUUID(),
      keyId: apiKey.id,
      platformId: route.platform.id,
      model: body.model,
      status: 200,
      tokens: 0,
      duration,
      isError: false,
      createdAt: new Date().toISOString(),
    }).catch(() => {});

    // 透传上游响应
    const responseHeaders = new Headers();
    const upstreamContentType = upstreamResponse.headers.get("content-type");
    if (upstreamContentType) {
      responseHeaders.set("Content-Type", upstreamContentType);
    }
    const upstreamContentLength = upstreamResponse.headers.get("content-length");
    if (upstreamContentLength) {
      responseHeaders.set("Content-Length", upstreamContentLength);
    }

    return new Response(upstreamResponse.body, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    if (!upstreamSucceeded) {
      await recordFailure(c.env, route.platform.id).catch(() => {});
    }

    const duration = Date.now() - startTime;
    await db.insert(requestLogs).values({
      id: crypto.randomUUID(),
      keyId: apiKey.id,
      platformId: route.platform.id,
      model: body.model,
      status: 500,
      tokens: 0,
      duration,
      isError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString(),
    }).catch(() => {});

    return c.json(
      { error: { message: "请求上游音频服务失败", type: "server_error" } },
      500
    );
  }
}

/**
 * 处理 multipart/form-data 格式的音频请求（transcriptions / translations）
 *
 * 从 multipart 中提取表单字段和音频文件，替换 model 后转发到上游。
 */
async function handleMultipartAudio(
  c: Context<{ Bindings: Env }>,
  db: ReturnType<typeof createDb>,
  apiKey: { id: string; rpmLimit?: number | null; tpmLimit?: number | null; plan?: { rpmLimit?: number; tpmLimit?: number } | null },
  startTime: number
) {
  // 解析 multipart 表单
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json(
      { error: { message: "解析 multipart 表单失败", type: "invalid_request_error" } },
      400
    );
  }

  const model = formData.get("model");
  if (!model || typeof model !== "string") {
    return c.json(
      { error: { message: "缺少必要的 model 参数", type: "invalid_request_error" } },
      400
    );
  }

  // 3. 路由选择
  const route = await routeRequest(c.env, model);
  if (!route) {
    return c.json(
      { error: { message: "没有可用的上游平台", type: "server_error" } },
      503
    );
  }

  // 3.1 模型类型校验 — 仅允许 audio 类型
  const allowedModelTypes: ModelType[] = ["audio"];
  const modelType = detectModelType(model);
  if (!allowedModelTypes.includes(modelType)) {
    const allowedNames = allowedModelTypes.map(t => MODEL_TYPE_NAMES[t]).join("、");
    return c.json({
      error: {
        message: `模型 '${model}' 是${MODEL_TYPE_NAMES[modelType]}模型，不支持此端点。请使用对应类型的端点（支持：${allowedNames}）`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_supported",
      }
    }, 400);
  }

  // 4. 速率限制检查
  const rateResult = await checkPlatformRateLimit(
    c.env, route.platform.id, route.platform.rpmLimit, route.platform.tpmLimit
  );
  if (!rateResult.allowed) {
    return c.json(
      { error: { message: "请求速率超过限制，请稍后重试", type: "rate_limit_error" } },
      429,
      { "X-RateLimit-Reset": String(Math.ceil(rateResult.resetAt / 1000)) }
    );
  }

  // 4.1 API Key 级速率限制
  const effectiveRpmLimit = apiKey.rpmLimit ?? apiKey.plan?.rpmLimit ?? null;
  const effectiveTpmLimit = apiKey.tpmLimit ?? apiKey.plan?.tpmLimit ?? null;
  const apiKeyRateResult = await checkKeyRateLimit(c.env, apiKey.id, effectiveRpmLimit, effectiveTpmLimit);
  if (!apiKeyRateResult.allowed) {
    return c.json(
      { error: { message: "API Key 请求速率超过限制，请稍后重试", type: "rate_limit_error" } },
      429,
      { "X-RateLimit-Reset": String(Math.ceil(apiKeyRateResult.resetAt / 1000)) }
    );
  }

  // 5. 构建上游请求
  const audioPath = getAudioPath(c.req.url);
  const upstreamUrl = `${route.platform.baseUrl}${audioPath}`;
  const upstreamKey = await getNextKey(c.env, { ...route.platform, apiKeys: JSON.stringify(route.platform.apiKeys) });
  if (!upstreamKey) {
    return c.json(
      { error: { message: "平台没有可用的 API Key", type: "server_error" } },
      503
    );
  }

  const forwardedHeaders = extractForwardableHeaders(
    c.req.raw, route.platform.forwardHeaders
  );

  let upstreamSucceeded = false;

  try {
    // 重建 FormData，将 model 替换为目标模型
    const upstreamFormData = new FormData();
    for (const [key, value] of formData.entries()) {
      if (key === "model") {
        upstreamFormData.append(key, route.targetModel);
      } else if (typeof value !== "string") {
        upstreamFormData.append(key, value, (value as File).name);
      } else {
        upstreamFormData.append(key, value);
      }
    }

    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${upstreamKey}`,
        ...forwardedHeaders,
      },
      body: upstreamFormData,
      signal: AbortSignal.timeout(300_000),
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      await recordFailure(c.env, route.platform.id);

      // 记录错误日志
      const duration = Date.now() - startTime;
      await db.insert(requestLogs).values({
        id: crypto.randomUUID(),
        keyId: apiKey.id,
        platformId: route.platform.id,
        model,
        status: upstreamResponse.status,
        tokens: 0,
        duration,
        isError: true,
        errorMessage: errorText.substring(0, 1000),
        createdAt: new Date().toISOString(),
      }).catch(() => {});

      const errorBody = sanitizeUpstreamError(errorText, upstreamResponse.status);
      return new Response(errorBody, {
        status: upstreamResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // transcriptions / translations 返回 JSON
    upstreamSucceeded = true;
    await recordSuccess(c.env, route.platform.id);

    const responseData = await upstreamResponse.json();

    // 记录成功日志（无 token 扣减）
    const duration = Date.now() - startTime;
    await db.insert(requestLogs).values({
      id: crypto.randomUUID(),
      keyId: apiKey.id,
      platformId: route.platform.id,
      model,
      status: 200,
      tokens: 0,
      duration,
      isError: false,
      createdAt: new Date().toISOString(),
    }).catch(() => {});

    return c.json(responseData);
  } catch (error) {
    if (!upstreamSucceeded) {
      await recordFailure(c.env, route.platform.id).catch(() => {});
    }

    const duration = Date.now() - startTime;
    await db.insert(requestLogs).values({
      id: crypto.randomUUID(),
      keyId: apiKey.id,
      platformId: route.platform.id,
      model,
      status: 500,
      tokens: 0,
      duration,
      isError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString(),
    }).catch(() => {});

    return c.json(
      { error: { message: "请求上游音频服务失败", type: "server_error" } },
      500
    );
  }
}
