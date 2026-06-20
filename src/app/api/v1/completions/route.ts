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

      return new Response(errorText, {
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

      const usageTransformer = new TransformStream({
        transform(chunk, controller) {
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
    await recordSuccess(route.platform.id);

    const usage = responseData.usage;
    const totalTokens = usage
      ? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)
      : 0;

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

    return Response.json(responseData);
  } catch (error) {
    await recordFailure(route.platform.id);
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

    return Response.json(
      { error: { message: "请求上游服务失败" } },
      { status: 500 }
    );
  }
}
