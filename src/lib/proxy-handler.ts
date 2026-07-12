/**
 * 代理请求公共处理逻辑
 *
 * 提取 chat/completions 和 completions 路由共享的：
 * - API Key 校验与额度检查
 * - 请求体解析与大小限制
 * - 平台级 + Key 级速率限制
 * - 流式响应 TransformStream（usage 提取）
 * - Token 扣减与日志记录
 * - 上游错误脱敏
 */

import { prisma } from "./prisma";
import { checkPlatformRateLimit, recordPlatformTokens, checkKeyRateLimit, recordApiKeyTokens } from "./rate-limiter";
import { checkAndResetApiKey } from "./api-key-reset";
import type { ApiKey, Plan } from "@prisma/client";

// ==================== 上游错误脱敏 ====================

/**
 * 脱敏上游错误响应，仅提取错误消息，不透传完整响应体
 *
 * 防止上游 API 的内部信息（API Key、内部路径、堆栈等）泄露给客户端。
 */
export function sanitizeUpstreamError(
  errorText: string,
  upstreamStatus: number
): string {
  try {
    const parsed = JSON.parse(errorText);
    // 提取 OpenAI 兼容格式的 error.message
    const message =
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.detail ||
      "";
    return JSON.stringify({
      error: {
        message: String(message).substring(0, 500) || "上游服务返回错误",
        type: "upstream_error",
        upstream_status: upstreamStatus,
      },
    });
  } catch {
    // 非 JSON 响应，返回通用错误
    return JSON.stringify({
      error: {
        message: "上游服务返回未知错误",
        type: "upstream_error",
        upstream_status: upstreamStatus,
      },
    });
  }
}

// ==================== API Key 校验 ====================

/** 带 plan 关联的 ApiKey 查询结果类型 */
export type ApiKeyWithPlan = ApiKey & { plan: Plan | null };

/**
 * 从请求中提取并验证 API Key
 *
 * @returns apiKey（验证通过）或 { error: Response }（验证失败，直接返回给客户端）
 */
export async function validateApiKey(
  authorizationHeader: string | null
): Promise<{ apiKey: ApiKeyWithPlan } | { error: Response }> {
  const apiKeyStr = authorizationHeader?.replace("Bearer ", "");

  if (!apiKeyStr) {
    return {
      error: Response.json(
        { error: { message: "缺少 API Key", type: "invalid_request_error" } },
        { status: 401 }
      ),
    };
  }

  const apiKey = await prisma.apiKey.findUnique({
    where: { key: apiKeyStr },
    include: { plan: true },
  });

  if (!apiKey || apiKey.status !== "active") {
    return {
      error: Response.json(
        { error: { message: "无效的 API Key", type: "invalid_request_error" } },
        { status: 401 }
      ),
    };
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return {
      error: Response.json(
        { error: { message: "API Key 已过期", type: "invalid_request_error" } },
        { status: 401 }
      ),
    };
  }

  // 检查是否需要重置 API Key 用量（根据 resetPeriod）
  await checkAndResetApiKey(apiKey.id);

  // 检查调用次数限制（callLimit），仅统计当前重置周期内的调用次数
  const effectiveCallLimit = apiKey.callLimit ?? apiKey.plan?.callLimit ?? null;
  if (effectiveCallLimit !== null) {
    const now = new Date();
    let periodStart: Date;
    const resetPeriod = apiKey.resetPeriod ?? apiKey.plan?.resetPeriod ?? "never";
    if (resetPeriod === "daily") {
      periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (resetPeriod === "monthly") {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      periodStart = new Date(0);
    }

    const callCount = await prisma.requestLog.count({
      where: {
        keyId: apiKey.id,
        createdAt: { gte: periodStart },
      },
    });
    if (callCount >= effectiveCallLimit) {
      return {
        error: Response.json(
          { error: { message: "API Key 调用次数已达上限", type: "invalid_request_error" } },
          { status: 429 }
        ),
      };
    }
  }

  return { apiKey };
}

// ==================== 请求体解析 ====================

/** 最大请求体大小：10 MB */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * 读取并解析请求体，包含大小限制和 JSON 校验
 *
 * @returns bodyText（原始文本）+ body（解析后的 JSON）或 { error: Response }
 */
export async function parseRequestBody<T>(
  request: Request
): Promise<{ bodyText: string; body: T } | { error: Response }> {
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

  // 使用 Buffer.byteLength 检查实际字节数，而非 string.length（后者仅统计 UTF-16 code unit，多字节字符会被低估）
  if (Buffer.byteLength(bodyText, "utf8") > MAX_BODY_BYTES) {
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

  return { bodyText, body };
}

// ==================== 速率限制 ====================

/**
 * 检查平台级 + Key 级速率限制
 *
 * @returns { allowed: true } 或 { error: Response }
 */
export function checkRateLimits(
  platform: { id: string; rpmLimit: number | null; tpmLimit: number | null },
  apiKey: ApiKeyWithPlan
): { allowed: true } | { error: Response } {
  // 平台级速率限制
  const rateResult = checkPlatformRateLimit(
    platform.id,
    platform.rpmLimit,
    platform.tpmLimit
  );

  if (!rateResult.allowed) {
    return {
      error: Response.json(
        {
          error: { message: "请求速率超过限制，请稍后再试", type: "rate_limit_error" },
        },
        {
          status: 429,
          headers: { "X-RateLimit-Reset": String(Math.ceil(rateResult.resetAt / 1000)) },
        }
      ),
    };
  }

  // Key 级速率限制（Key 级 → Plan 级回退）
  const effectiveRpmLimit = apiKey.rpmLimit ?? apiKey.plan?.rpmLimit ?? null;
  const effectiveTpmLimit = apiKey.tpmLimit ?? apiKey.plan?.tpmLimit ?? null;
  const apiKeyRateResult = checkKeyRateLimit(
    apiKey.id,
    effectiveRpmLimit,
    effectiveTpmLimit
  );

  if (!apiKeyRateResult.allowed) {
    return {
      error: Response.json(
        {
          error: { message: "API Key 请求速率超过限制，请稍后重试", type: "rate_limit_error" },
        },
        {
          status: 429,
          headers: { "X-RateLimit-Reset": String(Math.ceil(apiKeyRateResult.resetAt / 1000)) },
        }
      ),
    };
  }

  return { allowed: true };
}

// ==================== 流式响应 TransformStream ====================

export interface StreamTransformContext {
  apiKeyId: string;
  platformId: string;
  model: string;
  startTime: number;
  apiKey: ApiKeyWithPlan;
  platformTpmLimit: number | null;
}

/**
 * 创建流式响应的 TransformStream，在透传 SSE 数据的同时提取 usage 信息
 */
export function createUsageTransformer(ctx: StreamTransformContext) {
  let capturedUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  let firstTokenTime: number | null = null;
  let lastChunkTime = Date.now();
  let chunkCount = 0;
  const CHUNK_TIMEOUT_MS = 60_000;

  const transformer = new TransformStream({
    transform(chunk: Uint8Array, controller) {
      const now = Date.now();
      if (now - lastChunkTime > CHUNK_TIMEOUT_MS) {
        controller.error(new Error("流式响应超时"));
        return;
      }
      lastChunkTime = now;
      chunkCount++;

      if (firstTokenTime === null) {
        firstTokenTime = now;
      }

      controller.enqueue(chunk);

      try {
        const text = new TextDecoder().decode(chunk);
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
      // usage 提取失败时记录警告，便于排查问题
      if (!capturedUsage && chunkCount > 0) {
        console.warn(
          `[proxy-handler] 流式响应未提取到 usage 信息，chunks: ${chunkCount}，platform: ${ctx.platformId}，model: ${ctx.model}`
        );
      }
      await flushTokenUsage(ctx, capturedUsage, firstTokenTime);
    },
  });

  return transformer;
}

/**
 * 流结束时的 Token 扣减与日志记录
 *
 * token 扣减和日志记录在同一事务中执行，确保数据一致性。
 * 数据库操作失败时仅记录错误，不中断流的正常关闭。
 */
async function flushTokenUsage(
  ctx: StreamTransformContext,
  capturedUsage: { prompt_tokens?: number; completion_tokens?: number } | null,
  firstTokenTime: number | null
): Promise<void> {
  const promptTokens = capturedUsage?.prompt_tokens || 0;
  const completionTokens = capturedUsage?.completion_tokens || 0;
  const totalTokens = promptTokens + completionTokens;
  const ttft = firstTokenTime !== null ? firstTokenTime - ctx.startTime : 0;
  const duration = Date.now() - ctx.startTime;

  try {
    // Token 扣减、日志记录在同一事务中执行，确保数据一致性
    await prisma.$transaction(async (tx) => {
      // Token 扣减与额度检查
      const effectiveTokenLimit =
        ctx.apiKey.tokenLimit ?? ctx.apiKey.plan?.tokenQuota ?? null;
      if (effectiveTokenLimit !== null) {
        const updated = await tx.apiKey.update({
          where: { id: ctx.apiKeyId },
          data: { usedTokens: { increment: totalTokens } },
          select: { usedTokens: true },
        });
        if (Number(updated.usedTokens) >= effectiveTokenLimit) {
          await tx.apiKey.update({
            where: { id: ctx.apiKeyId },
            data: { status: "disabled" },
          });
        }
      } else {
        await tx.apiKey.update({
          where: { id: ctx.apiKeyId },
          data: { usedTokens: { increment: totalTokens } },
        });
      }

      // 记录日志（同一事务中）
      await tx.requestLog.create({
        data: {
          keyId: ctx.apiKeyId,
          platformId: ctx.platformId,
          model: ctx.model,
          status: 200,
          tokens: totalTokens,
          promptTokens,
          completionTokens,
          ttft,
          duration,
          isError: false,
        },
      });
    });

    // 追溯性 TPM 检查（事务外，仅记录警告）
    if (totalTokens > 0) {
      const tpmResult = recordPlatformTokens(
        ctx.platformId,
        ctx.platformTpmLimit,
        totalTokens
      );
      if (!tpmResult.allowed) {
        console.warn(
          `[proxy-handler] 流式响应 平台 ${ctx.platformId} TPM 已超限`,
          { totalTokens, tpmLimit: ctx.platformTpmLimit }
        );
      }

      const apiKeyTpmResult = recordApiKeyTokens(
        ctx.apiKeyId,
        ctx.apiKey.tpmLimit,
        totalTokens
      );
      if (!apiKeyTpmResult.allowed) {
        console.warn(
          `[proxy-handler] 流式响应 API Key ${ctx.apiKeyId} TPM 已超限`,
          { totalTokens, tpmLimit: ctx.apiKey.tpmLimit }
        );
      }
    }
  } catch (dbError) {
    console.error(
      "[proxy-handler] flush 阶段数据库操作失败:",
      dbError instanceof Error ? dbError.message : String(dbError)
    );
  }
}
