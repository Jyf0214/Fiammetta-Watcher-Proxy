/**
 * POST /v1/embeddings — Embeddings 代理接口
 *
 * 兼容 OpenAI SDK 的 Embeddings 端点。
 * 仅允许 embedding 类型的模型，不支持流式响应。
 * 透传上游响应并记录 token 用量。
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
import { applyRequestTemplates } from "../../lib/request-templates";
import { apiKeys, requestLogs } from "../../db/schema";
import { eq } from "drizzle-orm";

interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: string;
  dimensions?: number;
}

export async function embeddings(c: Context<{ Bindings: Env }>) {
  const startTime = Date.now();
  const db = createDb(c.env.DB);

  // 1. 验证 API Key
  const authHeader = c.req.header("authorization");
  const authResult = await validateApiKey(db, c.env, authHeader ?? null);
  if ("error" in authResult) return authResult.error;
  const { apiKey } = authResult;

  // 2. 解析请求体
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

  let body: EmbeddingRequest;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return c.json(
      { error: { message: "请求体格式错误", type: "invalid_request_error" } },
      400
    );
  }

  if (!body.model || !body.input) {
    return c.json(
      { error: { message: "缺少必要的 model 或 input 参数", type: "invalid_request_error" } },
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

  // 4. 速率限制检查
  const rateResult = await checkPlatformRateLimit(
    c.env, route.platform.id, route.platform.rpmLimit, route.platform.tpmLimit
  );
  if (!rateResult.allowed) {
    return c.json(
      { error: { message: "请求速率超过限制，请稍后重试", type: "rate_limit_error" } },
      429
    );
  }

  // 4.1 API Key 级速率限制
  const effectiveRpmLimit = apiKey.rpmLimit ?? apiKey.plan?.rpmLimit ?? null;
  const effectiveTpmLimit = apiKey.tpmLimit ?? apiKey.plan?.tpmLimit ?? null;
  const apiKeyRateResult = await checkKeyRateLimit(c.env, apiKey.id, effectiveRpmLimit, effectiveTpmLimit);
  if (!apiKeyRateResult.allowed) {
    return c.json(
      { error: { message: "API Key 请求速率超过限制，请稍后重试", type: "rate_limit_error" } },
      429
    );
  }

  // 5. 转发请求到上游
  const upstreamUrl = `${route.platform.baseUrl}/embeddings`;
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
    // 构建上游请求体
    const upstreamBody = await applyRequestTemplates(
      c.env,
      {
        ...body,
        model: route.targetModel,
      },
      "embeddings"
    );

    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${upstreamKey}`,
        ...forwardedHeaders,
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(120_000),
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      await recordFailure(c.env, route.platform.id);

      if (isAutoModelRequest(body.model)) {
        freezeAutoModel(c.env, route.targetModel);
      }

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

    // 6. 非流式响应处理（Embeddings 不支持流式）
    const responseData = await upstreamResponse.json();
    upstreamSucceeded = true;
    await recordSuccess(c.env, route.platform.id);

    // 提取 token 用量
    const usage = (responseData as Record<string, unknown>).usage as Record<string, number> | undefined;
    const totalTokens = usage?.total_tokens || 0;

    // Token 扣减
    try {
      const effectiveTokenLimit = apiKey.tokenLimit ?? apiKey.plan?.tokenQuota ?? null;
      if (effectiveTokenLimit !== null) {
        const current = await db.select({ usedTokens: apiKeys.usedTokens })
          .from(apiKeys).where(eq(apiKeys.id, apiKey.id)).get();
        const newUsed = (current?.usedTokens ?? 0) + totalTokens;
        await db.update(apiKeys).set({ usedTokens: newUsed })
          .where(eq(apiKeys.id, apiKey.id));
        if (newUsed >= effectiveTokenLimit) {
          await db.update(apiKeys).set({ status: "disabled" })
            .where(eq(apiKeys.id, apiKey.id));
        }
      } else {
        await db.update(apiKeys)
          .set({ usedTokens: (apiKey.usedTokens ?? 0) + totalTokens })
          .where(eq(apiKeys.id, apiKey.id));
      }

      await db.insert(requestLogs).values({
        id: crypto.randomUUID(),
        keyId: apiKey.id,
        platformId: route.platform.id,
        model: body.model,
        status: 200,
        tokens: totalTokens,
        promptTokens: totalTokens,
        completionTokens: 0,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: false,
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    } catch (txErr) {
      console.error("[embeddings] token扣减失败:", txErr);
    }

    return c.json(responseData);
  } catch (error) {
    if (!upstreamSucceeded) {
      await recordFailure(c.env, route.platform.id).catch(() => {});
      if (isAutoModelRequest(body.model)) {
        freezeAutoModel(c.env, route.targetModel);
      }
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
      { error: { message: "请求上游服务失败", type: "server_error" } },
      500
    );
  }
}
