/**
 * Token 计算和统计
 *
 * 从上游响应中提取 token 用量信息，
 * 更新 API Key 已用 token 数，记录请求日志。
 */

import { createPrismaClient } from "./prisma-db";

/**
 * 从 OpenAI 格式的 usage 对象中提取 token 数
 */
export function extractUsage(usage: Record<string, unknown> | undefined): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  if (!usage) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  let promptTokens = Number(usage.prompt_tokens) || 0;
  let completionTokens = Number(usage.completion_tokens) || 0;
  const totalTokens =
    Number(usage.total_tokens) || promptTokens + completionTokens;

  // 某些上游只返回 total_tokens，不返回 prompt/completion 分项
  // 此时将 total_tokens 同时记入两个字段，确保日志不丢失信息
  if (totalTokens > 0 && promptTokens === 0 && completionTokens === 0) {
    promptTokens = totalTokens;
    completionTokens = totalTokens;
  }

  return { promptTokens, completionTokens, totalTokens };
}

/**
 * 更新 API Key 的已用 token 数
 */
export async function updateKeyUsage(
  apiKeyId: string,
  tokenCount: number,
  db: D1Database
): Promise<void> {
  if (tokenCount <= 0) return;

  const prisma = await createPrismaClient(db);
  try {
    await prisma.apiKeys.update({
      where: { id: apiKeyId },
      data: {
        usedTokens: { increment: tokenCount },
        callUsed: { increment: 1 },
        updatedAt: Math.floor(Date.now() / 1000),
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 记录请求日志
 */
export async function recordRequestLog(params: {
  keyId: string | null;
  keyName: string | null;
  platformId: string | null;
  model: string;
  endpoint: string;
  method: string;
  status: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  ttft: number;
  duration: number;
  isError: boolean;
  errorMessage?: string;
  db: D1Database;
}): Promise<void> {
  const prisma = await createPrismaClient(params.db);
  try {
    await prisma.requestLogs.create({
      data: {
        id: crypto.randomUUID(),
        keyId: params.keyId,
        keyName: params.keyName,
        platformId: params.platformId,
        model: params.model,
        endpoint: params.endpoint,
        method: params.method,
        status: params.status,
        latency: params.duration,
        tokens: params.tokens,
        promptTokens: params.promptTokens,
        completionTokens: params.completionTokens,
        ttft: params.ttft,
        isError: params.isError,
        errorMessage: params.errorMessage ?? null,
        createdAt: Math.floor(Date.now() / 1000),
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 创建 Usage 提取 TransformStream
 *
 * 在流式响应中逐块解析 SSE 数据，提取最后一个 usage 对象，
 * 请求完成后异步更新 API Key 用量和日志。
 *
 * 关键设计：
 * - 用 ctx.waitUntil() 保护异步 DB 写入，防止 Worker 提前终止
 * - 记录 TTFT（首字延迟）：第一个非空 chunk 到达时的时间差
 * - SSE buffer 拼接：处理 chunk 在 JSON 中间截断的情况
 */
export function createUsageTransformer(params: {
  keyId: string;
  keyName: string | null;
  platformId: string;
  model: string;
  startTime: number;
  kv: KVNamespace;
  db: D1Database;
  ctx: ExecutionContext;
}): TransformStream<Uint8Array, Uint8Array> {
  let sseBuffer = "";
  let lastUsage: Record<string, unknown> | undefined;
  let ttft = 0;
  let isFirstChunk = true;
  let chunkCount = 0;
  const decoder = new TextDecoder();

  return new TransformStream({
    transform(chunk, controller) {
      chunkCount++;

      if (isFirstChunk) {
        ttft = Date.now() - params.startTime;
        isFirstChunk = false;
      }

      controller.enqueue(chunk);

      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) {
            lastUsage = parsed.usage;
          }
        } catch {
          // 忽略不完整的 JSON 片段
        }
      }
    },

    async flush() {
      if (!lastUsage && chunkCount > 0) {
        console.warn(
          `[token] 流式响应未提取到 usage，chunks: ${chunkCount}，model: ${params.model}`
        );
      }

      const { promptTokens, completionTokens, totalTokens } =
        extractUsage(lastUsage);
      const duration = Date.now() - params.startTime;

      // 复用同一个 PrismaClient 完成所有 DB 操作
      const prisma = await createPrismaClient(params.db);
      try {
        if (totalTokens > 0) {
          await prisma.apiKeys.update({
            where: { id: params.keyId },
            data: {
              usedTokens: { increment: totalTokens },
              callUsed: { increment: 1 },
              updatedAt: Math.floor(Date.now() / 1000),
            },
          });
        }

        await prisma.requestLogs.create({
          data: {
            id: crypto.randomUUID(),
            keyId: params.keyId,
            keyName: params.keyName,
            platformId: params.platformId,
            model: params.model,
            endpoint: "stream",
            method: "POST",
            status: 200,
            latency: duration,
            tokens: totalTokens,
            promptTokens,
            completionTokens,
            ttft,
            isError: false,
            createdAt: Math.floor(Date.now() / 1000),
          },
        });
      } catch (err) {
        console.error(
          "[token] 流式响应 DB 写入失败:",
          err instanceof Error ? err.message : String(err)
        );
      } finally {
        await prisma.$disconnect();
      }
    },
  });
}
