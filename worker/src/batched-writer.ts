/**
 * 批量写入缓冲器
 *
 * 将每个代理请求的 apiKeys.update + requestLogs.create 从逐条写入改为批量 flush：
 * - apiKeys.update：按 keyId 聚合增量，flush 时单条 UPDATE per key（N 请求 → 1 查询/key）
 * - requestLogs.create：积满一批后 createMany（N 请求 → 1 批量 INSERT）
 *
 * 预估节省：每日 5000 请求 × 2 写入 = 10000 CU → ~500 CU（每5秒 flush 一次）
 *
 * 设计约束：
 * - 进程内缓冲，重启后未 flush 数据丢失（可接受，用量统计允许微小偏差）
 * - flush 时若 DB 异常，缓冲数据保留至下次 flush 重试
 * - 空闲时也有定时 flush（防止低流量场景日志积压）
 */

import { createDb } from "@/lib/prisma";
import type { WorkerEnv } from "./config";
import { incrementCallLimitCount } from "./auth";

// ==================== 类型 ====================

interface PendingKeyUsage {
  tokenCount: number;
  callCount: number;
}

interface PendingLogEntry {
  id: string;
  keyId: string | null;
  keyName: string | null;
  platformId: string | null;
  model: string;
  endpoint: string;
  method: string;
  status: number;
  latency: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  /** 单次请求成本（美元，按模型价格表计算；无价格数据记 0） */
  cost: number;
  ttft: number;
  isError: boolean;
  errorMessage: string | null;
  nodeName: string | null;
  proxyUrl: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: number;
}

// ==================== 缓冲状态 ====================

/** 按 keyId 聚合的待写入 Key 用量 */
const pendingKeyUsages = new Map<string, PendingKeyUsage>();
/** 待写入的请求日志条目 */
const pendingLogs: PendingLogEntry[] = [];

/** 最近一次 flush 使用的 DB 绑定（首次 flush 时捕获） */
let flushDb: D1Database | null = null;
let flushEnv: WorkerEnv | undefined;

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 50;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let isFlushing = false;

// ==================== 公开接口 ====================

/**
 * 缓冲一次 Key 用量更新（替代直接调用 prisma.apiKeys.update）
 *
 * 在进程内聚合：同一 flush 窗口内同一 keyId 的多次增量合并为一次 UPDATE。
 * flush 失败时数据保留在缓冲中，下次 flush 自动重试。
 */
export function bufferKeyUsage(keyId: string, tokenCount: number): void {
  if (tokenCount <= 0) return;
  const existing = pendingKeyUsages.get(keyId);
  if (existing) {
    existing.tokenCount += tokenCount;
    existing.callCount += 1;
  } else {
    pendingKeyUsages.set(keyId, { tokenCount, callCount: 1 });
  }
  // 同步递增 callLimit 内存计数器（成功请求才调用 bufferKeyUsage，0 CU）
  incrementCallLimitCount(keyId);
  scheduleFlush();
}

/**
 * 缓冲一条请求日志（替代直接调用 prisma.requestLogs.create）
 *
 * 积满 FLUSH_BATCH_SIZE 条后触发立即 flush，否则等定时 flush。
 */
export function bufferRequestLog(entry: Omit<PendingLogEntry, "id" | "createdAt">): void {
  pendingLogs.push({
    ...entry,
    id: crypto.randomUUID(),
    createdAt: Math.floor(Date.now() / 1000),
  });
  if (pendingLogs.length >= FLUSH_BATCH_SIZE) {
    flushNow();
  } else {
    scheduleFlush();
  }
}

// ==================== 内部实现 ====================

function scheduleFlush(): void {
  if (flushTimer || isFlushing) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushNow();
  }, FLUSH_INTERVAL_MS);
}

/** 将已取出的数据放回缓冲区（createDb 失败或 DB 未初始化时调用） */
function rollbackBuffers(
  keyUsages: Map<string, PendingKeyUsage>,
  logs: PendingLogEntry[]
): void {
  for (const [k, v] of keyUsages) {
    const existing = pendingKeyUsages.get(k);
    if (existing) {
      existing.tokenCount += v.tokenCount;
      existing.callCount += v.callCount;
    } else {
      pendingKeyUsages.set(k, v);
    }
  }
  pendingLogs.unshift(...logs);
}

async function flushNow(): Promise<void> {
  if (isFlushing) return;
  if (pendingKeyUsages.size === 0 && pendingLogs.length === 0) return;

  isFlushing = true;
  try {
    // 取出当前缓冲，清空后释放锁——新请求可继续缓冲
    const keyUsages = new Map(pendingKeyUsages);
    pendingKeyUsages.clear();
    const logs = pendingLogs.splice(0, pendingLogs.length);

    const db = flushDb;
    const env = flushEnv;
    if (!db) {
      // 首次 flush 未初始化 DB，把数据放回缓冲
      rollbackBuffers(keyUsages, logs);
      return;
    }

    let prisma;
    try {
      prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
    } catch (err) {
      // DB 连接失败时把已取出的数据放回缓冲，下次 flush 重试
      console.error("[batched-writer] createDb 失败，数据回写缓冲:", err instanceof Error ? err.message : String(err));
      rollbackBuffers(keyUsages, logs);
      return;
    }

    // 并行写入 Key 用量和请求日志；写失败的条目收集后放回缓冲下次重试，
    // 兑现文件头"flush 失败数据保留"承诺（此前仅打日志、数据静默丢失）
    const writePromises: Promise<unknown>[] = [];
    const failedKeyUsages = new Map<string, PendingKeyUsage>();
    let logsWriteFailed = false;

    // Key 用量：按 keyId 聚合后逐条 UPDATE（Prisma 不支持批量 UPDATE）
    for (const [keyId, usage] of keyUsages) {
      writePromises.push(
        prisma.apiKeys
          .update({
            where: { id: keyId },
            data: {
              usedTokens: { increment: usage.tokenCount },
              callUsed: { increment: usage.callCount },
              updatedAt: Math.floor(Date.now() / 1000),
            },
          })
          .catch((err) => {
            console.error(
              `[batched-writer] Key ${keyId} 用量更新失败:`,
              err instanceof Error ? err.message : String(err)
            );
            // P2025（记录不存在，Key 在缓冲期间被删除）直接丢弃：
            // 回滚重试会形成每 5 秒失败循环直到进程重启
            if ((err as { code?: string })?.code !== "P2025") {
              failedKeyUsages.set(keyId, usage);
            }
          })
      );
    }

    // 请求日志：批量 createMany
    if (logs.length > 0) {
      writePromises.push(
        prisma.requestLogs
          .createMany({ data: logs })
          .catch((err) => {
            console.error(
              `[batched-writer] 请求日志批量写入失败 (${logs.length} 条):`,
              err instanceof Error ? err.message : String(err)
            );
            logsWriteFailed = true;
          })
      );
    }

    await Promise.allSettled(writePromises);

    if (failedKeyUsages.size > 0 || logsWriteFailed) {
      rollbackBuffers(failedKeyUsages, logsWriteFailed ? logs : []);
    }
  } catch (err) {
    console.error(
      "[batched-writer] flush 异常:",
      err instanceof Error ? err.message : String(err)
    );
  } finally {
    isFlushing = false;
    // flush 后仍有积压则继续调度
    if (pendingKeyUsages.size > 0 || pendingLogs.length > 0) {
      scheduleFlush();
    }
  }
}

/**
 * 初始化批量写入器（绑定 DB 绑定并启动定时 flush）
 *
 * 在进程启动时调用一次（各入口首请求时懒初始化）。
 */
export function initBatchedWriter(db: D1Database, env?: WorkerEnv): void {
  flushDb = db;
  flushEnv = env;
  scheduleFlush();
}

/**
 * 获取当前缓冲状态（监控/调试用）
 */
export function getBatchedWriterStats(): {
  pendingKeyUsages: number;
  pendingLogs: number;
} {
  return {
    pendingKeyUsages: pendingKeyUsages.size,
    pendingLogs: pendingLogs.length,
  };
}
