/**
 * POST /v1/chat/completions — Chat Completions 代理接口
 *
 * 兼容 OpenAI SDK，支持流式和非流式响应。
 * 从原 Next.js Route Handler 迁移到 Hono。
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
import { eq, sql } from "drizzle-orm";
import { recordPlatformTokens, recordApiKeyTokens } from "../../lib/rate-limiter";

interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: string;
    content: string | null;
    name?: string;
    function_call?: { name: string; arguments: string };
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  n?: number;
}

export async function chatCompletions(c: Context<{ Bindings: Env }>) {
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

  let body: ChatCompletionRequest;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return c.json(
      { error: { message: "请求体格式错误", type: "invalid_request_error" } },
      400
    );
  }

  if (!body.model || !body.messages || !Array.isArray(body.messages)) {
    return c.json(
      { error: { message: "缺少必要的 model 或 messages 参数", type: "invalid_request_error" } },
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
  const upstreamUrl = `${route.platform.baseUrl}/chat/completions`;
  const isStream = body.stream === true;
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
        ...(isStream ? { stream_options: { include_usage: true } } : {}),
      },
      "chat/completions"
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

    // 6. 流式响应处理
    if (isStream) {
      const stream = upstreamResponse.body;
      if (!stream) {
        await recordFailure(c.env, route.platform.id);
        return c.json(
          { error: { message: "上游未返回流式响应", type: "server_error" } },
          500
        );
      }

      // 流式响应 TransformStream — 在透传数据的同时提取 usage
      let capturedUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
      let firstTokenTime: number | null = null;
      let lastChunkTime = Date.now();

      const usageTransformer = new TransformStream({
        transform(chunk: Uint8Array, controller) {
          const now = Date.now();
          if (now - lastChunkTime > 60_000) {
            controller.error(new Error("流式响应超时"));
            return;
          }
          lastChunkTime = now;
          if (firstTokenTime === null) firstTokenTime = now;
          controller.enqueue(chunk);

          try {
            const text = new TextDecoder().decode(chunk);
            for (const line of text.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.usage) capturedUsage = parsed.usage;
              } catch { /* 忽略单行解析失败 */ }
            }
          } catch { /* 忽略 */ }
        },
        async flush() {
          const promptTokens = capturedUsage?.prompt_tokens || 0;
          const completionTokens = capturedUsage?.completion_tokens || 0;
          const totalTokens = promptTokens + completionTokens;
          const ttft = firstTokenTime !== null ? firstTokenTime - startTime : 0;
          const duration = Date.now() - startTime;

          // Token 扣减与日志（失败不中断流）
          try {
            const effectiveTokenLimit = apiKey.tokenLimit ?? apiKey.plan?.tokenQuota ?? null;
            if (effectiveTokenLimit !== null) {
              const result = await db.update(apiKeys)
                .set({ usedTokens: sql`COALESCE(${apiKeys.usedTokens}, 0) + ${totalTokens}` })
                .where(eq(apiKeys.id, apiKey.id))
                .returning({ usedTokens: apiKeys.usedTokens });
              const newUsed = result[0]?.usedTokens ?? 0;
              if (newUsed >= effectiveTokenLimit) {
                await db.update(apiKeys).set({ status: "disabled" })
                  .where(eq(apiKeys.id, apiKey.id));
              }
            } else {
              await db.update(apiKeys)
                .set({ usedTokens: sql`COALESCE(${apiKeys.usedTokens}, 0) + ${totalTokens}` })
                .where(eq(apiKeys.id, apiKey.id));
            }

            await db.insert(requestLogs).values({
              id: crypto.randomUUID(),
              keyId: apiKey.id,
              platformId: route.platform.id,
              model: body.model,
              status: 200,
              tokens: totalTokens,
              promptTokens,
              completionTokens,
              ttft,
              duration,
              isError: false,
              createdAt: new Date().toISOString(),
            }).catch(() => {});

            // 追溯性 TPM 检查：流式响应已完成，记录实际 token 用量
            if (totalTokens > 0) {
              const tpmResult = await recordPlatformTokens(c.env, route.platform.id, route.platform.tpmLimit, totalTokens);
              if (!tpmResult.allowed) {
                console.warn(`[chat/completions] 流式响应 平台 ${route.platform.id} TPM 已超限`, { totalTokens, tpmLimit: route.platform.tpmLimit });
              }
              const apiKeyTpmResult = await recordApiKeyTokens(c.env, apiKey.id, effectiveTpmLimit, totalTokens);
              if (!apiKeyTpmResult.allowed) {
                console.warn(`[chat/completions] 流式响应 API Key ${apiKey.id} TPM 已超限`, { totalTokens, tpmLimit: effectiveTpmLimit });
              }
            }
          } catch (dbError) {
            console.error("[chat/completions] flush 阶段数据库操作失败:", dbError);
          }
        },
      });

      const pipedStream = stream.pipeThrough(usageTransformer);
      upstreamSucceeded = true;
      await recordSuccess(c.env, route.platform.id);

      return new Response(pipedStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // 7. 非流式响应处理
    const responseData = await upstreamResponse.json();
    upstreamSucceeded = true;
    await recordSuccess(c.env, route.platform.id);

    const usage = (responseData as Record<string, unknown>).usage as Record<string, number> | undefined;
    const promptTokens = usage?.prompt_tokens || 0;
    const completionTokens = usage?.completion_tokens || 0;
    const totalTokens = promptTokens + completionTokens;

    // Token 扣减
    try {
      const effectiveTokenLimit = apiKey.tokenLimit ?? apiKey.plan?.tokenQuota ?? null;
      if (effectiveTokenLimit !== null) {
        const result = await db.update(apiKeys)
          .set({ usedTokens: sql`COALESCE(${apiKeys.usedTokens}, 0) + ${totalTokens}` })
          .where(eq(apiKeys.id, apiKey.id))
          .returning({ usedTokens: apiKeys.usedTokens });
        const newUsed = result[0]?.usedTokens ?? 0;
        if (newUsed >= effectiveTokenLimit) {
          await db.update(apiKeys).set({ status: "disabled" })
            .where(eq(apiKeys.id, apiKey.id));
        }
      } else {
        await db.update(apiKeys)
          .set({ usedTokens: sql`COALESCE(${apiKeys.usedTokens}, 0) + ${totalTokens}` })
          .where(eq(apiKeys.id, apiKey.id));
      }

      await db.insert(requestLogs).values({
        id: crypto.randomUUID(),
        keyId: apiKey.id,
        platformId: route.platform.id,
        model: body.model,
        status: 200,
        tokens: totalTokens,
        promptTokens,
        completionTokens,
        ttft: 0,
        duration: Date.now() - startTime,
        isError: false,
        createdAt: new Date().toISOString(),
      }).catch(() => {});

      // 追溯性 TPM 检查：非流式响应已完成，记录实际 token 用量
      if (totalTokens > 0) {
        const tpmResult = await recordPlatformTokens(c.env, route.platform.id, route.platform.tpmLimit, totalTokens);
        if (!tpmResult.allowed) {
          console.warn(`[chat/completions] 非流式 平台 ${route.platform.id} TPM 已超限`, { totalTokens, tpmLimit: route.platform.tpmLimit });
        }
        const apiKeyTpmResult = await recordApiKeyTokens(c.env, apiKey.id, effectiveTpmLimit, totalTokens);
        if (!apiKeyTpmResult.allowed) {
          console.warn(`[chat/completions] 非流式 API Key ${apiKey.id} TPM 已超限`, { totalTokens, tpmLimit: effectiveTpmLimit });
        }
      }
    } catch (txErr) {
      console.error("[chat/completions] token扣减失败:", txErr);
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
