/**
 * Token 计算和统计
 *
 * 从上游响应中提取 token 用量信息，
 * 更新 API Key 已用 token 数，记录请求日志。
 */

import { createDb } from "@/lib/prisma";
import { normalizeProxyStatKey } from "@/lib/upstream-proxy";
import { recordFailure } from "./load-balancer";
import { banKey, recordKeyError } from "./platform-keys";
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
    // 上游未返回 usage 时用请求体预估值兜底（与下方 totalTokens<=0 同一防绕过语义）
    if (maxTokensEstimate > 0) {
      return {
        promptTokens: maxTokensEstimate,
        completionTokens: 0,
        totalTokens: maxTokensEstimate,
      };
    }
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
  /** 客户端真实 IP（从下游请求头提取，日志页展示用；不传写 null） */
  ipAddress?: string;
  /** 客户端 User-Agent（从下游请求头提取，日志页展示用；不传写 null） */
  userAgent?: string;
  /** 出站代理地址（仅 Docker 部署经代理的请求记录；直连/其他部署为空） */
  proxyUrl?: string;
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
        // 落库前归一化为去凭据的 host:port 统计键（同 host:port 不同凭据的
        // 代理共享同一键，stats 聚合与前端查表一致；凭据不进入日志表。
        // 历史 ***@host:port 键在 stats 聚合侧同样归一化，自动并入新键）
        proxyUrl: params.proxyUrl ? normalizeProxyStatKey(params.proxyUrl) : null,
        ipAddress: params.ipAddress ?? null,
        userAgent: params.userAgent ?? null,
        createdAt: Math.floor(Date.now() / 1000),
      },
    });
  } catch (err) {
    console.error("[token] 记录请求日志失败:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * 从下游请求提取客户端 IP/UA（请求日志展示用）
 *
 * Worker 部署由 Cloudflare 注入 cf-connecting-ip；其他部署回退
 * X-Forwarded-For 首项（取最左客户端项）。
 */
export function extractClientInfo(
  request: Request
): { ipAddress?: string; userAgent?: string } {
  const ipAddress =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    undefined;
  return {
    ipAddress,
    userAgent: request.headers.get("user-agent") || undefined,
  };
}

/**
 * 从流内 error 事件中解析 HTTP 状态码
 *
 * 上游网关对失败请求可能返回 200 + SSE 流内 `data: {"error": {"code": 503}}`，
 * 此时 HTTP 头无法反映失败。code 为 400-599 的整数才视为有效状态码，
 * 否则返回 null（调用方回退到 200 成功路径）。
 */
export function resolveStreamErrorStatus(error: Record<string, unknown> | undefined): number | null {
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
 * - 记录 TTFT（首字延迟）：第一个非空 chunk 到达时的时间差
 * - SSE buffer 拼接：处理 chunk 在 JSON 中间截断的情况
 */
export function createUsageTransformer(params: {
  keyId: string;
  keyName: string | null;
  platformId: string;
  model: string;
  startTime: number;
  /** 上游平台 Key 明文：流内密钥类错误（429/401/402/403）时封禁+计数；不传则跳过密钥级处理 */
  key?: string;
  /** max_tokens 预估值：上游未返回 usage 时兜底记账，防 tokenLimit 绕过 */
  maxTokensEstimate?: number;
  /**
   * CF 部署的 KV binding：流内密钥类错误封禁时同时写 KV 持久化
   * （管理后台 keyStatuses CF 模式读 KV 展示、Worker 冷启动 loadKeyStatusFromKV
   * 恢复封禁），与 proxy.ts HTTP 429 路径 banKey(..., kv) 的 KV 键结构一致；
   * 非 Cloudflare 部署（无 KV）可不传，封禁只写内存 + DB 错误计数。
   */
  kv?: KVNamespace;
  db: D1Database;
  env?: WorkerEnv;
}): TransformStream<Uint8Array, Uint8Array> {
  let sseBuffer = "";
  let lastUsage: Record<string, unknown> | undefined;
  let streamError: { code: number; message: string } | undefined;
  // 上游正常结束的标志：SSE 流必须以 data: [DONE] 收尾。上游在思考中途截断
  // （EOF 但无 [DONE]）时若按成功记录，坏平台永远不会被熔断，负载均衡会反复撞上它
  let sawDone = false;
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
        if (data === "[DONE]") { sawDone = true; continue; }
        if (!data) continue;
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
      const { promptTokens, completionTokens, totalTokens } =
        extractUsage(lastUsage, params.maxTokensEstimate);
      const duration = Date.now() - params.startTime;

      // 上游流被截断：EOF 但未收到 [DONE]（如部分 zen-proxy 入口对长思考流 ~10s 截断）。
      // 客户端已收到 200 + 部分流无法改写状态码，但必须记失败并触发熔断，
      // 否则坏平台永远不会被降级，负载均衡会反复撞上它（此前一直记 200 成功）。
      const truncated = !sawDone && !streamError && chunkCount > 0;
      // 流内 error 与截断同属失败：触发熔断（此前流内 error 只记日志不打分，
      // 坏平台永远不被降级，负载均衡反复撞上它）
      if (streamError || truncated) {
        try { await recordFailure(params.platformId, params.db, params.env); } catch {}
      }

      // 流内 error 为密钥类状态码（429/401/402/403）时与 HTTP 重试路径对齐：
      // 封禁 Key + 累加错误计数（DB errorCount 达阈值自动禁用）。仅当调用方
      // 传入 key 明文时执行；kv 由调用方在 CF 部署下传入（env.KV），封禁同时
      // 写 KV 持久化（与 proxy.ts HTTP 429 路径 banKey(..., kv) 一致，管理后台
      // 可见、冷启动可恢复），无 KV 时只写内存；404/503 等非密钥错误不打 Key 分
      if (streamError && params.key &&
          (streamError.code === 429 || streamError.code === 401 ||
           streamError.code === 402 || streamError.code === 403)) {
        const keyErrorCode = streamError.code;
        try { await banKey(params.key, undefined, params.platformId, params.kv); } catch {}
        try { await recordKeyError(params.key, keyErrorCode, params.platformId, params.db, params.env); } catch {}
      }

      // 复用同一个 PrismaClient 完成所有 DB 操作
      const prisma = await createDb({ DB: params.db, DB_TYPE: params.env?.DB_TYPE });
      try {
        // 流内 error / 截断均视为失败请求：不计入 Key 用量/次数
        if (!streamError && !truncated && totalTokens > 0) {
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
            status: streamError ? streamError.code : truncated ? 502 : 200,
            latency: duration,
            tokens: streamError || truncated ? 0 : totalTokens,
            promptTokens: streamError || truncated ? 0 : promptTokens,
            completionTokens: streamError || truncated ? 0 : completionTokens,
            ttft,
            isError: !!streamError || truncated,
            errorMessage: streamError?.message ?? (truncated ? "上游流未正常结束（EOF 但未收到 [DONE]），疑似上游截断" : null),
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
