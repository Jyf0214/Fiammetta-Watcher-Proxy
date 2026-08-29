/**
 * API Key 认证与额度检查
 *
 * 从请求 Authorization 头提取 Bearer Token，验证 Key 有效性，
 * 检查过期时间、调用次数限制（callLimit）与 Token 额度限制（tokenLimit）。
 */

import { createDb } from "@/lib/prisma";
import type { WorkerEnv } from "./config";
import { getPeriodStart } from "./key-reset";
import { isClientIpAllowed, isModelAllowed } from "./api-key-allowlist";

// ==================== API Key 验证缓存 ====================

interface ApiKeyCacheEntry {
  record: ApiKeyRecord | null;
  expiresAt: number;
}

/**
 * 进程内 API Key 验证缓存
 *
 * 每个代理请求都会执行 apiKeys.findFirst（1 CU），高频场景下缓存显著减少 DB 查询。
 * - 有效 Key：缓存5秒（usedTokens 在写入路径中同步更新，缓存值偏差可接受）
 * - 无效/不存在 Key：缓存2秒（管理员启用后快速生效，同时阻止暴力探测）
 */
const apiKeyCache = new Map<string, ApiKeyCacheEntry>();
const API_KEY_VALID_TTL = 5_000;
const API_KEY_INVALID_TTL = 2_000;
const CACHE_MAX_SIZE = 1000;

function getCachedApiKey(key: string): ApiKeyCacheEntry | undefined {
  const entry = apiKeyCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    apiKeyCache.delete(key);
    return undefined;
  }
  return entry;
}

function setApiKeyCache(key: string, record: ApiKeyRecord | null): void {
  // 防止缓存无限增长（仅限制无效 Key 的探测缓存）
  if (apiKeyCache.size > CACHE_MAX_SIZE) {
    const now = Date.now();
    for (const [k, v] of apiKeyCache) {
      if (now > v.expiresAt) apiKeyCache.delete(k);
    }
    // 仍超限则清半
    if (apiKeyCache.size > CACHE_MAX_SIZE) {
      let count = 0;
      for (const k of apiKeyCache.keys()) {
        apiKeyCache.delete(k);
        if (++count >= CACHE_MAX_SIZE >> 1) break;
      }
    }
  }
  const ttl = record ? API_KEY_VALID_TTL : API_KEY_INVALID_TTL;
  apiKeyCache.set(key, { record, expiresAt: Date.now() + ttl });
}

/**
 * 主动失效 API Key 缓存（管理后台启用/禁用/删除 Key 后调用）
 */
export function invalidateApiKeyCache(key?: string): void {
  if (key) {
    apiKeyCache.delete(key);
  } else {
    apiKeyCache.clear();
  }
}

/**
 * 重置 callLimit 计数器缓存（仅测试用：清除跨用例的缓存污染）
 */
export function resetCallLimitCounters(): void {
  callLimitCounters.clear();
}

/**
 * API Key 查询结果类型
 *
 * 所有限额字段内联在 api_keys 表中。
 * rpm_limit、tpm_limit、call_limit 直接使用 Key 级别值。
 */
export interface ApiKeyRecord {
  id: string;
  key: string;
  name: string;
  usedTokens: bigint;
  rpmLimit: number | null;
  tpmLimit: number | null;
  callLimit: number | null;
  tokenLimit: number | null;
  callUsed: number;
  resetPeriod: string | null;
  allowedIps: string | null;
  allowedModels: string | null;
  status: string;
  expiresAt: number | null;
  updatedAt: number;
}

// ==================== callLimit 内存近似计数 ====================

interface CallLimitEntry {
  /** 最近一次从 DB 校准得到的调用次数 */
  calibratedCount: number;
  /** 校准时对应的 periodStart（周期切换时自动重新校准） */
  calibratedPeriodStart: number;
  /** 校准时间戳（毫秒） */
  calibratedAt: number;
  /** 校准后内存增量（本进程内新增的调用次数，下次校准归零） */
  localDelta: number;
}

/** 每个 keyId 的 callLimit 计数缓存 */
const callLimitCounters = new Map<string, CallLimitEntry>();

/** 校准间隔：60 秒（多实例下各实例独立校准，实际偏差 ≤ 60s） */
const CALIBRATE_INTERVAL_MS = 60_000;

/**
 * 获取近似调用次数（内存增量 + DB 校准基线）
 *
 * 首次访问或校准过期时从 DB 查询（2 CU），后续访问仅递增内存计数器（0 CU）。
 * 周期切换（如跨天）自动触发重新校准。
 * 进程重启后计数归零（冷启动首次访问触发校准），可接受。
 */
async function getApproximateCallCount(
  keyId: string,
  resetPeriod: string,
  periodStart: number,
  prisma: Awaited<ReturnType<typeof createDb>>
): Promise<number> {
  const now = Date.now();
  let entry = callLimitCounters.get(keyId);

  // 需要校准：首次访问 / 校准过期 / 周期已切换
  if (
    !entry ||
    now - entry.calibratedAt >= CALIBRATE_INTERVAL_MS ||
    entry.calibratedPeriodStart !== periodStart
  ) {
    const [recentCount, archivedAgg] = await Promise.all([
      prisma.requestLogs.count({
        // 仅计成功请求：与内存增量（incrementCallLimitCount 仅成功路径调用）及
        // apiKeys.callUsed 权威字段口径一致，避免失败多的 Key 限额被系统性提前耗尽
        where: { keyId, createdAt: { gte: periodStart }, isError: false },
      }),
      prisma.dailyStats.aggregate({
        where: { keyId, date: { gte: periodStart } },
        _sum: { totalRequests: true, errorRequests: true },
      }),
    ]);
    // 归档聚合的 totalRequests 含错误请求，减去 errorRequests 对齐成功口径
    // （旧归档行 errorRequests 可能为 0，仅造成保守方向的高估，随保留期滚动消失）
    const dbCount =
      recentCount +
      Number(archivedAgg._sum.totalRequests ?? 0) -
      Number(archivedAgg._sum.errorRequests ?? 0);
    entry = {
      calibratedCount: dbCount,
      calibratedPeriodStart: periodStart,
      calibratedAt: now,
      localDelta: 0,
    };
    callLimitCounters.set(keyId, entry);
  }

  return entry.calibratedCount + entry.localDelta;
}

/**
 * 递增 callLimit 内存计数器（代理请求成功后调用）
 *
 * 与 batched-writer 的 apiKeys.callUsed 更新解耦：
 * callUsed 是全量累计（不清零），callLimit 是周期内计数（按 periodStart 过滤）。
 */
export function incrementCallLimitCount(keyId: string): void {
  const entry = callLimitCounters.get(keyId);
  if (entry) {
    entry.localDelta += 1;
  }
  // 无缓存条目时不创建——首次校准由 getApproximateCallCount 触发
}

/**
 * 从请求中提取并验证 API Key
 *
 * @param authorizationHeader - 认证头原始值：OpenAI 客户端的 "Bearer <key>"
 *   或 Anthropic 客户端经 x-api-key 透传的裸密钥（无前缀，原样参与校验）
 * @param db - D1 数据库绑定
 * @param context - 可选上下文：clientIp（IP 白名单校验）、requestedModel（模型白名单校验）
 *   不传则跳过白名单检查（向后兼容：管理后台等场景无需白名单）
 * @returns apiKey（验证通过）或 { error: Response }（验证失败）
 */
export async function validateApiKey(
  authorizationHeader: string | null,
  db: D1Database,
  env?: WorkerEnv,
  context?: { clientIp?: string | null; requestedModel?: string | null }
): Promise<{ apiKey: ApiKeyRecord } | { error: Response }> {
  let apiKeyStr: string | null = null;
  if (authorizationHeader) {
    const trimmed = authorizationHeader.trim();
    if (trimmed.startsWith("Bearer ")) {
      apiKeyStr = trimmed.slice(7).trim();
    } else {
      // 非 Bearer 前缀原样参与校验：三端提取函数会把 Anthropic SDK 仅带的
      // x-api-key 裸密钥（无 Bearer 前缀）透传进来，此前置空导致这类客户端
      // 全部 401；非法值在下方查库时自然失败返回 401，不引入额外风险
      apiKeyStr = trimmed || null;
    }
  }

  if (!apiKeyStr) {
    return {
      error: Response.json(
        { error: { message: "缺少 API Key", type: "invalid_request_error" } },
        { status: 401 }
      ),
    };
  }

  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });

  try {
    // 查询 API Key（带缓存：有效 Key 5s TTL、无效/不存在 Key 2s TTL）
    let apiKey: ApiKeyRecord | null = null;
    const cached = getCachedApiKey(apiKeyStr);
    if (cached) {
      apiKey = cached.record;
    } else {
      const dbRecord = await prisma.apiKeys.findFirst({
        where: { key: apiKeyStr },
        select: {
          id: true,
          key: true,
          name: true,
          usedTokens: true,
          tokenLimit: true,
          rpmLimit: true,
          tpmLimit: true,
          callLimit: true,
          callUsed: true,
          resetPeriod: true,
          allowedIps: true,
          allowedModels: true,
          status: true,
          expiresAt: true,
          updatedAt: true,
        },
      });
      apiKey = dbRecord;
      setApiKeyCache(apiKeyStr, dbRecord);
    }

    if (!apiKey || apiKey.status !== "active") {
      return {
        error: Response.json(
          { error: { message: "无效的 API Key", type: "invalid_request_error" } },
          { status: 401 }
        ),
      };
    }

    // 检查过期时间
    const nowSec = Math.floor(Date.now() / 1000);
    if (apiKey.expiresAt !== null && apiKey.expiresAt < nowSec) {
      return {
        error: Response.json(
          { error: { message: "API Key 已过期", type: "invalid_request_error" } },
          { status: 401 }
        ),
      };
    }

    // IP 白名单（仅当 context.clientIp 显式传入时校验：管理后台等场景无需白名单）
    if (context?.clientIp !== undefined && !isClientIpAllowed(context.clientIp, apiKey.allowedIps)) {
      return {
        error: Response.json(
          { error: { message: "客户端 IP 不在 API Key 允许范围内", type: "invalid_request_error" } },
          { status: 403 }
        ),
      };
    }

    // 模型白名单（仅当 context.requestedModel 显式传入时校验）
    if (context?.requestedModel !== undefined && !isModelAllowed(context.requestedModel, apiKey.allowedModels)) {
      return {
        error: Response.json(
          { error: { message: `模型 ${context.requestedModel} 不在 API Key 允许范围内`, type: "invalid_request_error" } },
          { status: 403 }
        ),
      };
    }

    // 检查调用次数限制（内存近似计数 + 定时校准，替代每次请求 2 CU 的 DB 查询）
    const effectiveCallLimit = apiKey.callLimit ?? null;
    if (effectiveCallLimit !== null) {
      const resetPeriod = apiKey.resetPeriod ?? "never";
      const periodStart = getPeriodStart(resetPeriod);
      const callCount = await getApproximateCallCount(apiKey.id, resetPeriod, periodStart, prisma);

      if (callCount >= effectiveCallLimit) {
        return {
          error: Response.json(
            { error: { message: "API Key 调用次数已达上限", "type": "rate_limit_error" } },
            { status: 429 }
          ),
        };
      }
    }

    // 检查 Token 总额度限制（usedTokens 达到 tokenLimit 后拒绝新请求；0 表示不设限制）
    const effectiveTokenLimit = apiKey.tokenLimit ?? null;
    if (effectiveTokenLimit !== null && effectiveTokenLimit > 0 && Number(apiKey.usedTokens) >= effectiveTokenLimit) {
      return {
        error: Response.json(
          { error: { message: "API Key Token 额度已达上限", type: "rate_limit_error" } },
          { status: 429 }
        ),
      };
    }

    return { apiKey };
  } catch (err) {
    console.error("[auth] API Key 验证失败:", err instanceof Error ? err.message : String(err));
    return {
      error: Response.json(
        { error: { message: "服务器内部错误", type: "server_error" } },
        { status: 500 }
      ),
    };
  }
}

