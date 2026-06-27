import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { routeRequest } from "@/lib/router";
import { checkPlatformRateLimit } from "@/lib/rate-limiter";
import { recordSuccess, recordFailure } from "@/lib/circuit-breaker";
import type { CompletionRequest } from "@/types";

/**
 * POST /api/v1/completions — Completions 代理接口
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();

  // 1. 验证 API Key
  const authHeader = request.headers.get("authorization");
  const apiKeyStr = authHeader?.replace("Bearer ", "");

  if (!apiKeyStr) {
    return Response.json(
      { error: { message: "缺少 API Key", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  const apiKey = await prisma.apiKey.findUnique({
    where: { key: apiKeyStr },
    include: { plan: true },
  });

  if (!apiKey || apiKey.status !== "active") {
    return Response.json(
      { error: { message: "无效的 API Key", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return Response.json(
      { error: { message: "API Key 已过期", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  // 请求体大小限制（Route Handler 不受 serverActions.bodySizeLimit 影响，需手动检查）
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 10 * 1024 * 1024) {
    return Response.json(
      { error: { message: "请求体过大", type: "invalid_request_error" } },
      { status: 413 }
    );
  }

  // 2. 解析请求体
  let body: CompletionRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { message: "请求体格式错误", type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  if (!body.model || !body.prompt) {
    return Response.json(
      { error: { message: "缺少必要的 model 或 prompt 参数", type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  // 3. 路由选择
  const route = await routeRequest(body.model);
  if (!route) {
    return Response.json(
      { error: { message: "没有可用的上游平台", type: "server_error" } },
      { status: 503 }
    );
  }

  // 4. 速率限制
  const rateResult = checkPlatformRateLimit(
    route.platform.id,
    route.platform.rpmLimit,
    route.platform.tpmLimit
  );

  if (!rateResult.allowed) {
    return Response.json(
      { error: { message: "请求速率超过限制", type: "rate_limit_error" } },
      { status: 429 }
    );
  }

  // 5. 转发请求
  const upstreamUrl = `${route.platform.baseUrl}/completions`;
  const isStream = body.stream === true;

  // 上游请求超时控制：2 分钟
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);

  let upstreamSucceeded = false;
  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${route.platform.apiKey}`,
      },
      body: JSON.stringify({
        ...body,
        model: route.targetModel,
        // 流式请求强制要求上游返回 usage 数据，以便计费
        ...(isStream ? { stream_options: { include_usage: true } } : {}),
      }),
      signal: controller.signal,
    });

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      await recordFailure(route.platform.id);

      await prisma.requestLog.create({
        data: {
          keyId: apiKey.id,
          platformId: route.platform.id,
          model: body.model,
          status: upstreamResponse.status,
          tokens: 0,
          duration: Date.now() - startTime,
          isError: true,
          errorMessage: errorText.substring(0, 1000),
        },
      });

      // 尝试解析上游返回的错误为 JSON，解析失败则包装为标准错误格式
      let errorBody: string;
      try {
        JSON.parse(errorText);
        // 上游返回的是合法 JSON，直接透传
        errorBody = errorText;
      } catch {
        // 上游返回的不是 JSON（如纯文本、HTML 错误页），包装为标准错误响应
        errorBody = JSON.stringify({
          error: {
            message: errorText.substring(0, 500) || "上游返回了非 JSON 格式的错误响应",
            type: "upstream_error",
            upstream_status: upstreamResponse.status,
          },
        });
      }

      return new Response(errorBody, {
        status: upstreamResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 流式响应
    if (isStream) {
      const stream = upstreamResponse.body;
      if (!stream) {
        await recordFailure(route.platform.id);
        return Response.json(
          { error: { message: "上游未返回流式响应" } },
          { status: 500 }
        );
      }

      await recordSuccess(route.platform.id);

      // 通过 TransformStream 拦截 SSE 流，在透传数据的同时提取 usage 信息
      let capturedUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
      let lastChunkTime = Date.now();
      const CHUNK_TIMEOUT_MS = 60_000;

      const usageTransformer = new TransformStream({
        transform(chunk, controller) {
          // chunk 间超时检测：两个 chunk 间隔超过 60 秒则中断流
          const now = Date.now();
          if (now - lastChunkTime > CHUNK_TIMEOUT_MS) {
            controller.error(new Error("流式响应超时"));
            return;
          }
          lastChunkTime = now;

          // 原样透传 chunk 给客户端
          controller.enqueue(chunk);

          // 解析 SSE 事件提取 usage 数据
          try {
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            for (const line of text.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                if (parsed.usage) {
                  capturedUsage = parsed.usage;
                }
              } catch {
                // 单行 JSON 解析失败，忽略
              }
            }
          } catch {
            // chunk 解析失败，忽略
          }
        },
        async flush() {
          // 流结束：根据捕获的 usage 更新计费和日志
          const totalTokens = capturedUsage
            ? (capturedUsage.prompt_tokens || 0) + (capturedUsage.completion_tokens || 0)
            : 0;

          // 此处的数据库错误不能 throw，因为流已经发送给客户端，
          // throw 会导致未捕获异常并可能中断已部分发送的响应
          try {
            // 更新 apiKey.usedTokens 和额度检查
            const effectiveTokenLimit =
              apiKey.tokenLimit ?? apiKey.plan?.tokenQuota ?? null;
            if (effectiveTokenLimit !== null) {
              await prisma.$transaction(async (tx) => {
                const updated = await tx.apiKey.update({
                  where: { id: apiKey.id },
                  data: { usedTokens: { increment: totalTokens } },
                  select: { usedTokens: true },
                });
                if (Number(updated.usedTokens) >= effectiveTokenLimit) {
                  await tx.apiKey.update({
                    where: { id: apiKey.id },
                    data: { status: "disabled" },
                  });
                }
              });
            } else {
              await prisma.apiKey.update({
                where: { id: apiKey.id },
                data: { usedTokens: { increment: totalTokens } },
              });
            }

            // 记录日志（包含实际 token 数）
            const duration = Date.now() - startTime;
            await prisma.requestLog.create({
              data: {
                keyId: apiKey.id,
                platformId: route.platform.id,
                model: body.model,
                status: 200,
                tokens: totalTokens,
                duration,
                isError: false,
              },
            });
          } catch (dbError) {
            // 流式响应已发送给客户端，此处数据库失败只能记录日志，不能中断流
            console.error("[completions] 流式响应 flush 阶段数据库操作失败:", dbError);
          }
        },
      });

      return new Response(stream.pipeThrough(usageTransformer), {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // 非流式响应
    const responseData = await upstreamResponse.json();
    upstreamSucceeded = true;
    await recordSuccess(route.platform.id);

    const usage = responseData.usage;
    const totalTokens = usage
      ? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
      : 0;

    // token 扣减失败不应影响已成功的响应
    try {
      const effectiveTokenLimit =
        apiKey.tokenLimit ?? apiKey.plan?.tokenQuota ?? null;
      if (effectiveTokenLimit !== null) {
        // 有额度限制：事务内原子递增 + 超限禁用
        await prisma.$transaction(async (tx) => {
          const updated = await tx.apiKey.update({
            where: { id: apiKey.id },
            data: { usedTokens: { increment: totalTokens } },
            select: { usedTokens: true },
          });
          if (Number(updated.usedTokens) >= effectiveTokenLimit) {
            await tx.apiKey.update({
              where: { id: apiKey.id },
              data: { status: "disabled" },
            });
          }
        });
      } else {
        await prisma.apiKey.update({
          where: { id: apiKey.id },
          data: { usedTokens: { increment: totalTokens } },
        });
      }

      await prisma.requestLog.create({
        data: {
          keyId: apiKey.id,
          platformId: route.platform.id,
          model: body.model,
          status: 200,
          tokens: totalTokens,
          duration: Date.now() - startTime,
          isError: false,
        },
      });
    } catch (txErr) {
      console.error("[token扣减失败]", txErr);
    }

    return Response.json(responseData);
  } catch (error) {
    // 仅在上游请求本身失败时记录熔断失败，避免误触发熔断
    if (!upstreamSucceeded) {
      try {
        await recordFailure(route.platform.id);
      } catch {
        console.error("[completions] 熔断器记录失败:", error);
      }
    }

    try {
      await prisma.requestLog.create({
        data: {
          keyId: apiKey.id,
          platformId: route.platform.id,
          model: body.model,
          status: 500,
          tokens: 0,
          duration: Date.now() - startTime,
          isError: true,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    } catch (logError) {
      console.error("[completions] 错误日志写入失败:", logError);
    }

    return Response.json(
      { error: { message: "请求上游服务失败" } },
      { status: 500 }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
