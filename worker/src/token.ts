/**
 * Token 计算和统计
 *
 * 从上游响应中提取 token 用量信息，
 * 更新 API Key 已用 token 数，记录请求日志。
 */

import { createDb } from "@/lib/prisma";
import type { WorkerEnv } from "./config";

/**
 * 从 OpenAI 格式的 usage 对象中提取 token 数
 *
 * @param maxTokensEstimate - 请求体中的 max_tokens 预估值，用于防止上游返回 0 绕过配额
 */
export function extractUsage(
  usage: Record<string, unknown> | undefined,
  maxTokensEstimate: number = 0
): {
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

  // 防止上游篡改 token 计数绕过配额：usage 为 0 时使用请求体预估值
  if (totalTokens <= 0 && maxTokensEstimate > 0) {
    return {
      promptTokens: maxTokensEstimate,
      completionTokens: 0,
      totalTokens: maxTokensEstimate,
    };
  }

  return { promptTokens, completionTokens, totalTokens };
}

/**
 * 更新 API Key 的已用 token 数
 */
export async function updateKeyUsage(
  apiKeyId: string,
  tokenCount: number,
  db: D1Database,
  env?: WorkerEnv
): Promise<void> {
  if (tokenCount <= 0) return;

  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  try {
    await prisma.apiKeys.update({
      where: { id: apiKeyId },
      data: {
        usedTokens: { increment: tokenCount },
        callUsed: { increment: 1 },
        updatedAt: Math.floor(Date.now() / 1000),
      },
    });
  } catch (err) {
    console.error("[token] 更新 Key 用量失败:", err instanceof Error ? err.message : String(err));
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
  env?: WorkerEnv;
}): Promise<void> {
  const prisma = await createDb({ DB: params.db, DB_TYPE: params.env?.DB_TYPE });
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
  } catch (err) {
    console.error("[token] 记录请求日志失败:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * 从流内 error 事件中解析 HTTP 状态码
 *
 * 上游网关对失败请求可能返回 200 + SSE 流内 `data: {"error": {"code": 503}}`，
 * 此时 HTTP 头无法反映失败。code 为 400-599 的整数才视为有效状态码，
 * 否则返回 null（调用方回退到 200 成功路径）。
 */
function resolveStreamErrorStatus(error: Record<string, unknown> | undefined): number | null {
  if (!error || typeof error !== "object") return null;
  const raw = (error as Record<string, unknown>).code;
  const code =
    typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN;
  // 必须是 400-599 的整数：浮点等病态 code 会触发 Prisma Int 列校验错误，
  // 导致整条失败日志丢失（外层 catch 吞掉）
  if (!Number.isNaN(code) && Number.isInteger(code) && code >= 400 && code <= 599) return code;
  return null;
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
  env?: WorkerEnv;
}): TransformStream<Uint8Array, Uint8Array> {
  let sseBuffer = "";
  let lastUsage: Record<string, unknown> | undefined;
  let streamError: { code: number; message: string } | undefined;
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
          // 上游 200 + 流内 error 事件：失败语义由日志记录（status=error.code，isError=true）
          if (parsed.error) {
            const status = resolveStreamErrorStatus(parsed.error);
            if (status !== null) {
              streamError = {
                code: status,
                message: String(parsed.error.message || "").substring(0, 1000),
              };
            }
          }
        } catch {
          // 忽略不完整的 JSON 片段
        }
      }
    },

    async flush() {
      // 流内 error 事件本身无 usage，属于失败请求的正常形态，不告警
      if (!lastUsage && !streamError && chunkCount > 0) {
        console.warn(
          `[token] 流式响应未提取到 usage，chunks: ${chunkCount}，model: ${params.model}`
        );
      }

      const { promptTokens, completionTokens, totalTokens } =
        extractUsage(lastUsage);
      const duration = Date.now() - params.startTime;

      // 复用同一个 PrismaClient 完成所有 DB 操作
      const prisma = await createDb({ DB: params.db, DB_TYPE: params.env?.DB_TYPE });
      try {
        // 流内 error 视为失败请求：不计入 Key 用量/次数
        if (!streamError && totalTokens > 0) {
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
            status: streamError ? streamError.code : 200,
            latency: duration,
            tokens: streamError ? 0 : totalTokens,
            promptTokens: streamError ? 0 : promptTokens,
            completionTokens: streamError ? 0 : completionTokens,
            ttft,
            isError: !!streamError,
            errorMessage: streamError?.message ?? null,
            createdAt: Math.floor(Date.now() / 1000),
          },
        });
      } catch (err) {
        console.error(
          "[token] 流式响应 DB 写入失败:",
          err instanceof Error ? err.message : String(err)
        );
      }
    },
  });
}
