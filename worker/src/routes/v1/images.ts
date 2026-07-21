/**
 * POST /v1/images/generations, /v1/images/edits, /v1/images/variations — 图片代理接口
 *
 * 兼容 OpenAI SDK 的图片生成端点。
 * 支持 JSON 和 multipart/form-data 两种请求格式的转发。
 * 仅允许 image 类型的模型，透传上游响应体。
 */

import type { Context } from "hono";
import type { Env } from "../../types";
import { createDb } from "../../db";
import { validateApiKey } from "../../lib/auth";
import { routeRequest, isAutoModelRequest, freezeAutoModel } from "../../lib/router";
import { getNextKey } from "../../lib/platform-keys";
import { extractForwardableHeaders } from "../../lib/forward-headers";
import { checkPlatformRateLimit, checkKeyRateLimit } from "../../lib/rate-limiter";
import { recordSuccess, recordFailure } from "../../lib/circuit-breaker";
import { sanitizeUpstreamError } from "../../lib/proxy-handler";
import { requestLogs } from "../../db/schema";

export async function images(c: Context<{ Bindings: Env }>) {
  const startTime = Date.now();
  const db = createDb(c.env.DB);

  // 1. 验证 API Key
  const authHeader = c.req.header("authorization");
  const authResult = await validateApiKey(db, c.env, authHeader ?? null);
  if ("error" in authResult) return authResult.error;
  const { apiKey } = authResult;

  // 2. 确定上游路径 — 根据请求 URL 的 pathname 推断
  const requestUrl = new URL(c.req.url);
  const pathname = requestUrl.pathname; // 例如 /v1/images/generations
  // 提取 images/ 后面的部分：generations、edits、variations
  const pathSuffix = pathname.replace(/^\/v1\/images\//, "").replace(/\/$/, "");
  if (!["generations", "edits", "variations"].includes(pathSuffix)) {
    return c.json(
      { error: { message: "不支持的图片端点路径", type: "invalid_request_error" } },
      404
    );
  }

  // 3. 判断请求格式（JSON 或 multipart/form-data），提取 model 并保留请求体
  const contentType = c.req.header("content-type") || "";
  const isMultipart = contentType.includes("multipart/form-data");

  let bodyModel: string | undefined;

  if (isMultipart) {
    // multipart/form-data — 从 FormData 中读取 model 字段，同时克隆请求以备转发
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json(
        { error: { message: "读取 FormData 失败", type: "invalid_request_error" } },
        400
      );
    }
    bodyModel = formData.get("model") as string | undefined;

    if (!bodyModel) {
      return c.json(
        { error: { message: "缺少必要的 model 参数", type: "invalid_request_error" } },
        400
      );
    }

    // 4. 路由选择
    const route = await routeRequest(c.env, bodyModel);
    if (!route) {
      return c.json(
        { error: { message: "没有可用的上游平台", type: "server_error" } },
        503
      );
    }

    // 5. 速率限制检查
    const rateResult = await checkPlatformRateLimit(
      c.env, route.platform.id, route.platform.rpmLimit, route.platform.tpmLimit
    );
    if (!rateResult.allowed) {
      return c.json(
        { error: { message: "请求速率超过限制，请稍后重试", type: "rate_limit_error" } },
        429
      );
    }

    // 5.1 API Key 级速率限制
    const effectiveRpmLimit = apiKey.rpmLimit ?? apiKey.plan?.rpmLimit ?? null;
    const effectiveTpmLimit = apiKey.tpmLimit ?? apiKey.plan?.tpmLimit ?? null;
    const apiKeyRateResult = await checkKeyRateLimit(c.env, apiKey.id, effectiveRpmLimit, effectiveTpmLimit);
    if (!apiKeyRateResult.allowed) {
      return c.json(
        { error: { message: "API Key 请求速率超过限制，请稍后重试", type: "rate_limit_error" } },
        429
      );
    }

    // 6. 转发 multipart/form-data 到上游
    const upstreamUrl = `${route.platform.baseUrl}/images/${pathSuffix}`;
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
      // 构建新的 FormData，替换 model 值
      const newFormData = new FormData();
      for (const [key, value] of formData.entries()) {
        if (key === "model") {
          newFormData.append(key, route.targetModel);
        } else {
          newFormData.append(key, value);
        }
      }

      const upstreamResponse = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${upstreamKey}`,
          ...forwardedHeaders,
          // 注意：不设置 Content-Type，让 fetch 自动设置 multipart boundary
        },
        body: newFormData,
        signal: AbortSignal.timeout(300_000),
      });

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        await recordFailure(c.env, route.platform.id);

        if (isAutoModelRequest(bodyModel)) {
          freezeAutoModel(c.env, route.targetModel);
        }

        // 记录错误日志
        const duration = Date.now() - startTime;
        await db.insert(requestLogs).values({
          id: crypto.randomUUID(),
          keyId: apiKey.id,
          platformId: route.platform.id,
          model: bodyModel,
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

      // 7. 透传上游响应 — 保持原始 Content-Type 和响应体
      upstreamSucceeded = true;
      await recordSuccess(c.env, route.platform.id);

      // 记录成功日志（图片生成不记录 token）
      const duration = Date.now() - startTime;
      await db.insert(requestLogs).values({
        id: crypto.randomUUID(),
        keyId: apiKey.id,
        platformId: route.platform.id,
        model: bodyModel,
        status: 200,
        tokens: 0,
        duration,
        isError: false,
        createdAt: new Date().toISOString(),
      }).catch(() => {});

      // 透传上游响应头和响应体
      const responseHeaders = new Headers();
      const upstreamContentType = upstreamResponse.headers.get("Content-Type");
      if (upstreamContentType) {
        responseHeaders.set("Content-Type", upstreamContentType);
      }
      const contentLength = upstreamResponse.headers.get("Content-Length");
      if (contentLength) {
        responseHeaders.set("Content-Length", contentLength);
      }

      return new Response(upstreamResponse.body, {
        status: upstreamResponse.status,
        headers: responseHeaders,
      });
    } catch (error) {
      if (!upstreamSucceeded) {
        await recordFailure(c.env, route.platform.id).catch(() => {});
        if (isAutoModelRequest(bodyModel)) {
          freezeAutoModel(c.env, route.targetModel);
        }
      }

      const duration = Date.now() - startTime;
      await db.insert(requestLogs).values({
        id: crypto.randomUUID(),
        keyId: apiKey.id,
        platformId: route.platform.id,
        model: bodyModel,
        status: 500,
        tokens: 0,
        duration,
        isError: true,
        errorMessage: error instanceof Error ? error.message : String(error),
        createdAt: new Date().toISOString(),
      }).catch(() => {});

      return c.json(
        { error: { message: "请求上游服务失败", type: "server_error" } },
        500
      );
    }
  }

  // ========== JSON 格式处理 ==========
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

  let parsedBody: Record<string, unknown>;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    return c.json(
      { error: { message: "请求体格式错误", type: "invalid_request_error" } },
      400
    );
  }

  bodyModel = parsedBody.model as string | undefined;
  if (!bodyModel) {
    return c.json(
      { error: { message: "缺少必要的 model 参数", type: "invalid_request_error" } },
      400
    );
  }

  // 4. 路由选择
  const route = await routeRequest(c.env, bodyModel);
  if (!route) {
    return c.json(
      { error: { message: "没有可用的上游平台", type: "server_error" } },
      503
    );
  }

  // 5. 速率限制检查
  const rateResult = await checkPlatformRateLimit(
    c.env, route.platform.id, route.platform.rpmLimit, route.platform.tpmLimit
  );
  if (!rateResult.allowed) {
    return c.json(
      { error: { message: "请求速率超过限制，请稍后重试", type: "rate_limit_error" } },
      429
    );
  }

  // 5.1 API Key 级速率限制
  const effectiveRpmLimit = apiKey.rpmLimit ?? apiKey.plan?.rpmLimit ?? null;
  const effectiveTpmLimit = apiKey.tpmLimit ?? apiKey.plan?.tpmLimit ?? null;
  const apiKeyRateResult = await checkKeyRateLimit(c.env, apiKey.id, effectiveRpmLimit, effectiveTpmLimit);
  if (!apiKeyRateResult.allowed) {
    return c.json(
      { error: { message: "API Key 请求速率超过限制，请稍后重试", type: "rate_limit_error" } },
      429
    );
  }

  // 6. 转发 JSON 请求到上游
  const upstreamUrl = `${route.platform.baseUrl}/images/${pathSuffix}`;
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
    // 替换 model 为路由目标模型
    parsedBody.model = route.targetModel;

    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
        ...forwardedHeaders,
      },
      body: JSON.stringify(parsedBody),
      signal: AbortSignal.timeout(300_000),
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      await recordFailure(c.env, route.platform.id);

      if (isAutoModelRequest(bodyModel)) {
        freezeAutoModel(c.env, route.targetModel);
      }

      // 记录错误日志
      const duration = Date.now() - startTime;
      await db.insert(requestLogs).values({
        id: crypto.randomUUID(),
        keyId: apiKey.id,
        platformId: route.platform.id,
        model: bodyModel,
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

    // 7. 透传上游响应 — 保持原始 Content-Type 和响应体
    upstreamSucceeded = true;
    await recordSuccess(c.env, route.platform.id);

    // 记录成功日志（图片生成不记录 token）
    const duration = Date.now() - startTime;
    await db.insert(requestLogs).values({
      id: crypto.randomUUID(),
      keyId: apiKey.id,
      platformId: route.platform.id,
      model: bodyModel,
      status: 200,
      tokens: 0,
      duration,
      isError: false,
      createdAt: new Date().toISOString(),
    }).catch(() => {});

    // 透传上游响应头和响应体
    const responseHeaders = new Headers();
    const upstreamContentType = upstreamResponse.headers.get("Content-Type");
    if (upstreamContentType) {
      responseHeaders.set("Content-Type", upstreamContentType);
    }
    const contentLength = upstreamResponse.headers.get("Content-Length");
    if (contentLength) {
      responseHeaders.set("Content-Length", contentLength);
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    if (!upstreamSucceeded) {
      await recordFailure(c.env, route.platform.id).catch(() => {});
      if (isAutoModelRequest(bodyModel)) {
        freezeAutoModel(c.env, route.targetModel);
      }
    }

    const duration = Date.now() - startTime;
    await db.insert(requestLogs).values({
      id: crypto.randomUUID(),
      keyId: apiKey.id,
      platformId: route.platform.id,
      model: bodyModel,
      status: 500,
      tokens: 0,
      duration,
      isError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
      createdAt: new Date().toISOString(),
    }).catch(() => {});

    return c.json(
      { error: { message: "请求上游服务失败", type: "server_error" } },
      500
    );
  }
}
