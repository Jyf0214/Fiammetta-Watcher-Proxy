/**
 * V1 代理请求统一处理器
 *
 * 为 /v1/* 端点提供共享的代理逻辑：
 * - API Key 校验与额度检查
 * - 平台路由选择
 * - 平台级 + Key 级速率限制
 * - 上游转发（JSON / 流式 / multipart）
 * - 流式响应 TransformStream（usage 提取）
 * - Token 扣减与日志记录
 * - 上游错误脱敏
 *
 * 各端点只需传入配置即可复用全部代理逻辑。
 */

import { NextRequest } from "next/server";
import { routeRequest } from "./router";
import { getNextKey } from "./platform-keys";
import { platformFetch } from "./platform-fetch";
import { extractForwardableHeaders } from "./forward-headers";
import { recordSuccess, recordFailure } from "./circuit-breaker";
import {
  validateApiKey,
  parseRequestBody,
  checkRateLimits,
  createUsageTransformer,
  sanitizeUpstreamError,
  type ApiKeyWithPlan,
} from "./proxy-handler";
import { prisma } from "./prisma";
import { detectModelType, MODEL_TYPE_NAMES, type ModelType } from "./model-type";

// ==================== 配置接口 ====================

export interface V1ProxyConfig {
  /** 上游路径，如 "/chat/completions"、"/embeddings"、"/images/generations" */
  upstreamPath: string;
  /** 是否支持流式响应（SSE） */
  supportsStreaming?: boolean;
  /** 是否跳过 JSON 解析，直接转发原始请求体（用于 multipart/form-data） */
  streamBody?: boolean;
  /** 允许的模型类型列表，不在列表中的模型会被拦截 */
  allowedModelTypes?: ModelType[];
  /** 额外的请求体校验，返回 null 表示通过，否则返回错误 Response */
  validateBody?: (body: Record<string, unknown>) => Response | null;
  /** 构建发送给上游的请求体，默认为原始 body + model 替换 */
  buildUpstreamBody?: (body: Record<string, unknown>) => Record<string, unknown>;
}

// ==================== 统一代理入口 ====================

/**
 * 处理一个 V1 代理请求
 *
 * @param request - 原始请求
 * @param config - 端点配置
 * @returns Response
 */
export async function proxyV1Request(
  request: NextRequest,
  config: V1ProxyConfig
): Promise<Response> {
  const startTime = Date.now();
  const logTag = `[v1-proxy:${config.upstreamPath}]`;

  // ── 1. API Key 校验 ──
  const authResult = await validateApiKey(request.headers.get("authorization"));
  if ("error" in authResult) return authResult.error;
  const { apiKey } = authResult;

  // ── 2. 解析请求体 ──
  let body: Record<string, unknown> = {};

  if (config.streamBody) {
    // multipart 模式：不解析 JSON，直接转发原始流
    // 仅做基本的大小检查
    const contentLength = request.headers.get("content-length");
    if (contentLength && Number(contentLength) > 50 * 1024 * 1024) {
      return Response.json(
        { error: { message: "请求体过大", type: "invalid_request_error" } },
        { status: 413 }
      );
    }
  } else {
    // JSON 模式：解析请求体
    const parseResult = await parseRequestBody<Record<string, unknown>>(request);
    if ("error" in parseResult) return parseResult.error;
    body = parseResult.body;
  }

  // ── 3. 额外校验 ──
  if (config.validateBody && !config.streamBody) {
    const validationError = config.validateBody(body);
    if (validationError) return validationError;
  }

  // ── 4. 路由选择 ──
  const modelName = config.streamBody
    ? (request.headers.get("x-model") || undefined)
    : (body.model as string | undefined);

  const route = modelName
    ? await routeRequest(modelName)
    : await routeRequest("__any__");

  if (!route) {
    return Response.json(
      { error: { message: "没有可用的上游平台", type: "server_error" } },
      { status: 503 }
    );
  }

  // ── 4a. 模型类型校验 ──
  if (config.allowedModelTypes && modelName) {
    const modelType = detectModelType(modelName);
    if (!config.allowedModelTypes.includes(modelType)) {
      const allowedNames = config.allowedModelTypes
        .map((t) => MODEL_TYPE_NAMES[t])
        .join("、");
      return Response.json(
        {
          error: {
            message: `模型 '${modelName}' 是${MODEL_TYPE_NAMES[modelType]}模型，不支持此端点。请使用对应类型的端点（支持：${allowedNames}）`,
            type: "invalid_request_error",
            param: "model",
            code: "model_not_supported",
          },
        },
        { status: 400 }
      );
    }
  }

  // ── 5. 速率限制 ──
  const rateCheck = checkRateLimits(route.platform, apiKey);
  if ("error" in rateCheck) return rateCheck.error;

  // ── 6. 选择上游密钥 ──
  const upstreamKey = getNextKey(route.platform);
  if (!upstreamKey) {
    return Response.json(
      { error: { message: "平台没有可用的 API Key", type: "server_error" } },
      { status: 503 }
    );
  }

  // ── 7. 透传请求头 ──
  const forwardedHeaders = extractForwardableHeaders(
    request,
    route.platform.forwardHeaders
  );

  // ── 8. 转发请求 ──
  const upstreamUrl = `${route.platform.baseUrl}${config.upstreamPath}`;
  const isStream = config.supportsStreaming && body.stream === true;
  let upstreamSucceeded = false;

  try {
    let upstreamResponse: Response;

    try {
      if (config.streamBody) {
        // multipart 流转发：直接传递原始请求体
        upstreamResponse = await platformFetch(upstreamUrl, route.platform, {
          method: "POST",
          headers: {
            "Content-Type":
              request.headers.get("content-type") || "multipart/form-data",
            Authorization: `Bearer ${upstreamKey}`,
            ...forwardedHeaders,
          },
          body: request.body,
          timeout: 120_000,
          keyId: apiKey.id,
        });
      } else {
        // JSON 转发
        const upstreamBody = config.buildUpstreamBody
          ? config.buildUpstreamBody(body)
          : {
              ...body,
              model: route.targetModel,
              ...(isStream
                ? { stream_options: { include_usage: true } }
                : {}),
            };

        upstreamResponse = await platformFetch(upstreamUrl, route.platform, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${upstreamKey}`,
            ...forwardedHeaders,
          },
          body: JSON.stringify(upstreamBody),
          timeout: 120_000,
          keyId: apiKey.id,
        });
      }
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

    // ── 8a. 上游返回错误 ──
    if (!upstreamResponse.ok) {
      const errorText = await upstreamResponse.text();
      try {
        await recordFailure(route.platform.id);
      } catch (recordError) {
        console.error(
          `${logTag} 上游错误路径熔断器记录失败:`,
          recordError instanceof Error
            ? recordError.message
            : String(recordError)
        );
      }

      try {
        await prisma.requestLog.create({
          data: {
            keyId: apiKey.id,
            platformId: route.platform.id,
            model: modelName || "unknown",
            status: upstreamResponse.status,
            tokens: 0,
            duration: Date.now() - startTime,
            isError: true,
            errorMessage: errorText.substring(0, 1000),
          },
        });
      } catch (logError) {
        console.error(
          `${logTag} 记录上游错误日志失败:`,
          logError instanceof Error ? logError.message : String(logError)
        );
      }

      const errorBody = sanitizeUpstreamError(
        errorText,
        upstreamResponse.status
      );
      return new Response(errorBody, {
        status: upstreamResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── 8b. 流式响应（SSE） ──
    if (isStream) {
      const stream = upstreamResponse.body;
      if (!stream) {
        try {
          await recordFailure(route.platform.id);
        } catch {
          console.error(`${logTag} 流式响应缺失时熔断器记录失败`);
        }
        return Response.json(
          { error: { message: "上游未返回流式响应", type: "server_error" } },
          { status: 500 }
        );
      }

      const transformer = createUsageTransformer({
        apiKeyId: apiKey.id,
        platformId: route.platform.id,
        model: modelName || "unknown",
        startTime,
        apiKey,
        platformTpmLimit: route.platform.tpmLimit,
      });

      const pipedStream = stream.pipeThrough(transformer);
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

    // ── 8c. 非流式响应 ──
    // 对于 multipart 响应（audio/images），直接透传上游响应
    const responseContentType =
      upstreamResponse.headers.get("content-type") || "";
    if (responseContentType.includes("multipart/")) {
      upstreamSucceeded = true;
      await recordSuccess(route.platform.id);

      // 记录日志（无 token 统计）
      try {
        await prisma.requestLog.create({
          data: {
            keyId: apiKey.id,
            platformId: route.platform.id,
            model: modelName || "unknown",
            status: 200,
            tokens: 0,
            duration: Date.now() - startTime,
            isError: false,
          },
        });
      } catch (logError) {
        console.error(
          `${logTag} 日志写入失败:`,
          logError instanceof Error ? logError.message : String(logError)
        );
      }

      // 透传上游响应体和 headers
      return new Response(upstreamResponse.body, {
        status: 200,
        headers: {
          "Content-Type": responseContentType,
          ...(upstreamResponse.headers.get("content-disposition")
            ? {
                "Content-Disposition": upstreamResponse.headers.get(
                  "content-disposition"
                )!,
              }
            : {}),
        },
      });
    }

    // JSON 非流式响应
    const responseData = await upstreamResponse.json();
    upstreamSucceeded = true;
    await recordSuccess(route.platform.id);

    // Token 扣减与日志
    await recordNonStreamUsage(apiKey, route.platform, {
      model: modelName || "unknown",
      usage: responseData.usage,
      startTime,
    });

    return Response.json(responseData);
  } catch (error) {
    // ── 9. 异常处理 ──
    if (!upstreamSucceeded) {
      try {
        await recordFailure(route.platform.id);
      } catch {
        console.error(
          `${logTag} 熔断器记录失败:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    try {
      await prisma.requestLog.create({
        data: {
          keyId: apiKey.id,
          platformId: route.platform.id,
          model: modelName || "unknown",
          status: 500,
          tokens: 0,
          duration: Date.now() - startTime,
          isError: true,
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    } catch (logError) {
      console.error(
        `${logTag} 错误日志写入失败:`,
        logError instanceof Error ? logError.message : String(logError)
      );
    }

    return Response.json(
      { error: { message: "请求上游服务失败", type: "server_error" } },
      { status: 500 }
    );
  }
}

// ==================== 非流式 Token 扣减 ====================

async function recordNonStreamUsage(
  apiKey: ApiKeyWithPlan,
  platform: { id: string; tpmLimit: number | null },
  opts: {
    model: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    startTime: number;
  }
): Promise<void> {
  const promptTokens = opts.usage?.prompt_tokens || 0;
  const completionTokens = opts.usage?.completion_tokens || 0;
  const totalTokens = promptTokens + completionTokens;

  try {
    const { recordPlatformTokens, recordApiKeyTokens } = await import("./rate-limiter");

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

    await prisma.requestLog.create({
      data: {
        keyId: apiKey.id,
        platformId: platform.id,
        model: opts.model,
        status: 200,
        tokens: totalTokens,
        promptTokens,
        completionTokens,
        ttft: 0,
        duration: Date.now() - opts.startTime,
        isError: false,
      },
    });

    if (totalTokens > 0) {
      const tpmResult = recordPlatformTokens(
        platform.id,
        platform.tpmLimit,
        totalTokens
      );
      if (!tpmResult.allowed) {
        console.warn(
          `[v1-proxy] 平台 ${platform.id} TPM 已超限`,
          { totalTokens, tpmLimit: platform.tpmLimit }
        );
      }

      const apiKeyTpmResult = recordApiKeyTokens(
        apiKey.id,
        apiKey.tpmLimit,
        totalTokens
      );
      if (!apiKeyTpmResult.allowed) {
        console.warn(
          `[v1-proxy] API Key ${apiKey.id} TPM 已超限`,
          { totalTokens, tpmLimit: apiKey.tpmLimit }
        );
      }
    }
  } catch (txErr) {
    console.error(
      "[v1-proxy] token扣减失败",
      txErr instanceof Error ? txErr.message : String(txErr)
    );
  }
}
