import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { routeRequest } from "@/lib/router";
import { getNextKey } from "@/lib/platform-keys";
import { platformFetch } from "@/lib/platform-fetch";
import { extractForwardableHeaders } from "@/lib/forward-headers";
import { checkPlatformRateLimit, recordPlatformTokens, checkKeyRateLimit, recordApiKeyTokens } from "@/lib/rate-limiter";
import { recordSuccess, recordFailure } from "@/lib/circuit-breaker";
import { freezeAutoModel, isAutoModelRequest } from "@/lib/router";
import { checkAndResetApiKey } from "@/lib/api-key-reset";
import { sanitizeUpstreamError } from "@/lib/proxy-handler";
import type { ChatCompletionRequest } from "@/types";

/**
 * POST /api/v1/chat/completions — Chat Completions 代理接口
 * 兼容 OpenAI SDK，支持流式和非流式响应
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

  // 检查过期
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return Response.json(
      { error: { message: "API Key 已过期", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  // 检查是否需要重置 API Key 用量（根据 resetPeriod）
  await checkAndResetApiKey(apiKey.id);

  // 检查调用次数限制（callLimit），仅统计当前重置周期内的调用次数
  const effectiveCallLimit = apiKey.callLimit ?? apiKey.plan?.callLimit ?? null;
  if (effectiveCallLimit !== null) {
    // 根据 resetPeriod 计算当前周期起始时间
    const now = new Date();
    let periodStart: Date;
    const resetPeriod = apiKey.resetPeriod ?? apiKey.plan?.resetPeriod ?? "never";
    if (resetPeriod === "daily") {
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (resetPeriod === "monthly") {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      periodStart = new Date(0); // never：不限制，统计全部
    }

    const callCount = await prisma.requestLog.count({
      where: {
        keyId: apiKey.id,
        createdAt: { gte: periodStart },
      },
    });
    if (callCount >= effectiveCallLimit) {
      return Response.json(
        { error: { message: "API Key 调用次数已达上限", type: "invalid_request_error" } },
        { status: 429 }
      );
    }
  }

  // 2. 解析请求体（先读取文本检查大小，再解析JSON）
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return Response.json(
      { error: { message: "读取请求体失败", type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  // 请求体大小限制（Route Handler 不受 serverActions.bodySizeLimit 影响，需手动检查）
  // 使用 Buffer.byteLength 检查实际字节数，而非 string.length（后者仅统计 UTF-16 code unit，多字节字符会被低估）
  if (Buffer.byteLength(bodyText, "utf8") > 10 * 1024 * 1024) {
    return Response.json(
      { error: { message: "请求体过大", type: "invalid_request_error" } },
      { status: 413 }
    );
  }

  let body: ChatCompletionRequest;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return Response.json(
      { error: { message: "请求体格式错误", type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  if (!body.model || !body.messages || !Array.isArray(body.messages)) {
    return Response.json(
      { error: { message: "缺少必要的 model 或 messages 参数", type: "invalid_request_error" } },
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

  // 4. 速率限制检查
  const rateResult = checkPlatformRateLimit(
    route.platform.id,
    route.platform.rpmLimit,
    route.platform.tpmLimit
  );

  if (!rateResult.allowed) {
    return Response.json(
      {
        error: {
          message: "请求速率超过限制，请稍后重试",
          type: "rate_limit_error",
        },
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Reset": String(Math.ceil(rateResult.resetAt / 1000)),
        },
      }
    );
  }

  // 4.1 API Key 级别速率限制检查（Key 级 → Plan 级回退）
  const effectiveRpmLimit = apiKey.rpmLimit ?? apiKey.plan?.rpmLimit ?? null;
  const effectiveTpmLimit = apiKey.tpmLimit ?? apiKey.plan?.tpmLimit ?? null;
  const apiKeyRateResult = checkKeyRateLimit(
    apiKey.id,
    effectiveRpmLimit,
    effectiveTpmLimit
  );

  if (!apiKeyRateResult.allowed) {
    return Response.json(
      {
        error: {
          message: "API Key 请求速率超过限制，请稍后重试",
          type: "rate_limit_error",
        },
      },
      {
        status: 429,
        headers: {
          "X-RateLimit-Reset": String(Math.ceil(apiKeyRateResult.resetAt / 1000)),
        },
      }
    );
  }

  // 5. 转发请求到上游（含超时控制）
  const upstreamUrl = `${route.platform.baseUrl}/chat/completions`;
  const isStream = body.stream === true;

  // 轮询选择上游 API Key
  const upstreamKey = getNextKey(route.platform);
  if (!upstreamKey) {
    return Response.json(
      { error: { message: "平台没有可用的 API Key", type: "server_error" } },
      { status: 503 }
    );
  }

  // 从下游请求中提取平台配置的白名单请求头，透传给上游
  const forwardedHeaders = extractForwardableHeaders(request, route.platform.forwardHeaders);

  // 请求时无法预知流式响应的 token 数，因此 tokenCount 保持默认值 0，
  // 这是流式响应的固有限制——token 用量只能在流结束后从 usage chunk 中提取。
  let upstreamSucceeded = false;
  try {
    let upstreamResponse: Response;
    try {
      upstreamResponse = await platformFetch(upstreamUrl, route.platform, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${upstreamKey}`,
          ...forwardedHeaders,
        },
        body: JSON.stringify({
          ...body,
          model: route.targetModel,
          // 流式请求强制要求上游返回 usage 数据，以便计费
          ...(isStream ? { stream_options: { include_usage: true } } : {}),
        }),
        timeout: 120_000,
        keyId: apiKey.id,
      });
    } catch (fetchError) {
      if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
        return Response.json(
          { error: { message: "上游请求超时（2 分钟），请稍后重试", type: "timeout_error" } },
          { status: 504 }
        );
      }
      throw fetchError;
    }

    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      try {
        await recordFailure(route.platform.id);
      } catch (recordError) {
        // 仅输出错误信息，避免泄露完整堆栈
        console.error("[chat/completions] 上游错误路径熔断器记录失败:", recordError instanceof Error ? recordError.message : String(recordError));
      }

      // 自动模型请求失败时，临时冻结该模型（避免反复请求到异常模型）
      if (isAutoModelRequest(body.model)) {
        freezeAutoModel(route.targetModel);
      }

      // 记录错误日志
      const duration = Date.now() - startTime;
      try {
        await prisma.requestLog.create({
          data: {
            keyId: apiKey.id,
            platformId: route.platform.id,
            model: body.model,
            status: upstreamResponse.status,
            tokens: 0,
            duration,
            isError: true,
            errorMessage: errorText.substring(0, 1000),
          },
        });
      } catch (logError) {
        // 仅输出错误信息，避免泄露完整堆栈
        console.error("[chat/completions] 记录上游错误日志失败:", logError instanceof Error ? logError.message : String(logError));
      }

      // 脱敏处理：仅提取错误消息，不透传完整上游响应（防止泄露 API Key、内部路径等）
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
        try {
          await recordFailure(route.platform.id);
        } catch {
          // 仅输出错误信息，避免泄露完整堆栈
          console.error("[chat/completions] 流式响应缺失时熔断器记录失败");
        }
        return Response.json(
          { error: { message: "上游未返回流式响应", type: "server_error" } },
          { status: 500 }
        );
      }

      // 通过 TransformStream 拦截 SSE 流，在透传数据的同时提取 usage 信息
      let capturedUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
      let firstTokenTime: number | null = null;
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

          // 记录首个 token 到达时间（TTFT）
          if (firstTokenTime === null) {
            firstTokenTime = now;
          }

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
          const promptTokens = capturedUsage?.prompt_tokens || 0;
          const completionTokens = capturedUsage?.completion_tokens || 0;
          const totalTokens = promptTokens + completionTokens;
          // TTFT：首个 token 到达时间 - 请求开始时间
          const ttft = firstTokenTime !== null ? firstTokenTime - startTime : 0;

          // 数据库操作必须用 try-catch 包裹：flush() 中的错误不能中断流，
          // 否则客户端会收到不完整的 SSE 数据或连接异常中断。
          // 即使计费和日志写入失败，流式数据已经透传给客户端，不能因此破坏响应。
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

            // 记录日志（包含实际 token 数和 TTFT）
            const duration = Date.now() - startTime;
            await prisma.requestLog.create({
              data: {
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
              },
            });

            // 追溯性 TPM 检查：流式响应已完成，记录实际 token 用量到平台计数器
            if (totalTokens > 0) {
              const tpmResult = recordPlatformTokens(
                route.platform.id,
                route.platform.tpmLimit,
                totalTokens
              );
              if (!tpmResult.allowed) {
                console.warn(
                  `[chat/completions] 流式响应 平台 ${route.platform.id} TPM 已超限`,
                  { totalTokens, tpmLimit: route.platform.tpmLimit }
                );
              }

              // API Key 级别 TPM 追溯性检查
              const apiKeyTpmResult = recordApiKeyTokens(
                apiKey.id,
                apiKey.tpmLimit,
                totalTokens
              );
              if (!apiKeyTpmResult.allowed) {
                console.warn(
                  `[chat/completions] 流式响应 API Key ${apiKey.id} TPM 已超限`,
                  { totalTokens, tpmLimit: apiKey.tpmLimit }
                );
              }
            }
          } catch (dbError) {
            // 数据库操作失败时仅记录错误，不中断流的正常关闭
            // 仅输出错误信息，避免泄露完整堆栈
            console.error("[chat/completions] flush 阶段数据库操作失败:", dbError instanceof Error ? dbError.message : String(dbError));
          }
        },
      });

      const pipedStream = stream.pipeThrough(usageTransformer);

      // 标记成功：仅在流成功创建后设置，避免外层 catch 误调 recordFailure
      // 注意：流式消费由 HTTP 服务器异步执行，route handler 无法捕获消费过程中的错误
      upstreamSucceeded = true;
      await recordSuccess(route.platform.id);

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
    await recordSuccess(route.platform.id);

    // 提取 token 用量
    const usage = responseData.usage;
    const promptTokens = usage?.prompt_tokens || 0;
    const completionTokens = usage?.completion_tokens || 0;
    const totalTokens = promptTokens + completionTokens;

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

      // 记录日志
      const duration = Date.now() - startTime;
      await prisma.requestLog.create({
        data: {
          keyId: apiKey.id,
          platformId: route.platform.id,
          model: body.model,
          status: 200,
          tokens: totalTokens,
          promptTokens,
          completionTokens,
          ttft: 0, // 非流式响应无 TTFT
          duration,
          isError: false,
        },
      });
    } catch (txErr) {
      console.error("[token扣减失败]", txErr);
    }

    // 追溯性 TPM 检查：请求已完成，记录实际 token 用量到平台计数器
    if (totalTokens > 0) {
      const tpmResult = recordPlatformTokens(
        route.platform.id,
        route.platform.tpmLimit,
        totalTokens
      );
      if (!tpmResult.allowed) {
        console.warn(
          `[chat/completions] 平台 ${route.platform.id} TPM 已超限`,
          { totalTokens, tpmLimit: route.platform.tpmLimit }
        );
      }

      // API Key 级别 TPM 追溯性检查
      const apiKeyTpmResult = recordApiKeyTokens(
        apiKey.id,
        apiKey.tpmLimit,
        totalTokens
      );
      if (!apiKeyTpmResult.allowed) {
        console.warn(
          `[chat/completions] API Key ${apiKey.id} TPM 已超限`,
          { totalTokens, tpmLimit: apiKey.tpmLimit }
        );
      }
    }

    return Response.json(responseData);
  } catch (error) {
    // 仅在上游请求本身失败时记录熔断失败，避免误触发熔断
    if (!upstreamSucceeded) {
      try {
        await recordFailure(route.platform.id);
      } catch {
        // 仅输出错误信息，避免泄露完整堆栈
        console.error("[chat/completions] 熔断器记录失败:", error instanceof Error ? error.message : String(error));
      }

      // 自动模型请求失败时，临时冻结该模型
      if (isAutoModelRequest(body.model)) {
        freezeAutoModel(route.targetModel);
      }
    }

    try {
      const duration = Date.now() - startTime;
      await prisma.requestLog.create({
        data: {
          keyId: apiKey.id,
          platformId: route.platform.id,
          model: body.model,
          status: 500,
          tokens: 0,
          duration,
          isError: true,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    } catch (logError) {
      // 仅输出错误信息，避免泄露完整堆栈
      console.error("[chat/completions] 错误日志写入失败:", logError instanceof Error ? logError.message : String(logError));
    }

    return Response.json(
      { error: { message: "请求上游服务失败", type: "server_error" } },
      { status: 500 }
    );
  }
}
