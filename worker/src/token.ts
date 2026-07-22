/**
 * Token 计算和统计
 *
 * 从上游响应中提取 token 用量信息，
 * 更新 API Key 已用 token 数，记录请求日志。
 */

import { eq, sql } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";

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

  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const totalTokens =
    Number(usage.total_tokens) || promptTokens + completionTokens;

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

  const orm = createDb(db);
  await orm
    .update(schema.apiKeys)
    .set({
      usedTokens: sql`${schema.apiKeys.usedTokens} + ${tokenCount}`,
      callUsed: sql`${schema.apiKeys.callUsed} + 1`,
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(eq(schema.apiKeys.id, apiKeyId));
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
  duration: number;
  isError: boolean;
  errorMessage?: string;
  db: D1Database;
}): Promise<void> {
  const orm = createDb(params.db);
  const id = crypto.randomUUID();

  await orm.insert(schema.requestLogs).values({
    id,
    keyId: params.keyId,
    keyName: params.keyName,
    platformId: params.platformId,
    model: params.model,
    endpoint: params.endpoint,
    method: params.method,
    status: params.status,
    latency: params.duration,
    tokens: params.tokens,
    tokensPrompt: params.promptTokens,
    tokensCompletion: params.completionTokens,
    isError: params.isError,
    errorMessage: params.errorMessage ?? null,
  } as any);
}

/**
 * 创建 Usage 提取 TransformStream
 *
 * 在流式响应中逐块解析 SSE 数据，提取最后一个 usage 对象，
 * 请求完成后异步更新 API Key 用量和日志。
 */
export function createUsageTransformer(params: {
  keyId: string;
  keyName: string | null;
  platformId: string;
  model: string;
  startTime: number;
  kv: KVNamespace;
  db: D1Database;
}): TransformStream<Uint8Array, Uint8Array> {
  let buffer = "";
  let lastUsage: Record<string, unknown> | undefined;

  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      // 解码并缓冲 SSE 数据
      const text = new TextDecoder().decode(chunk);
      buffer += text;

      // 提取 usage（通常在最后一个 chunk）
      const usageMatch = text.match(/"usage"\s*:\s*(\{[^}]+\})/);
      if (usageMatch) {
        try {
          lastUsage = JSON.parse(usageMatch[1]);
        } catch {
          // 忽略解析错误
        }
      }
    },

    async flush() {
      // 流结束后异步处理 token 统计
      try {
        const { promptTokens, completionTokens, totalTokens } =
          extractUsage(lastUsage);

        if (totalTokens > 0) {
          await updateKeyUsage(params.keyId, totalTokens, params.db);
        }

        await recordRequestLog({
          keyId: params.keyId,
          keyName: params.keyName,
          platformId: params.platformId,
          model: params.model,
          endpoint: "stream",
          method: "POST",
          status: 200,
          tokens: totalTokens,
          promptTokens,
          completionTokens,
          duration: Date.now() - params.startTime,
          isError: false,
          db: params.db,
        });
      } catch (err) {
        console.error(
          "[token] 流式响应 token 统计失败:",
          err instanceof Error ? err.message : String(err)
        );
      }
    },
  });
}
