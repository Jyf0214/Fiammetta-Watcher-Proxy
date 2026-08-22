/**
 * API Key 认证与额度检查
 *
 * 从请求 Authorization 头提取 Bearer Token，验证 Key 有效性，
 * 检查过期时间、调用次数限制（callLimit）与 Token 额度限制（tokenLimit）。
 */

import { createDb } from "@/lib/prisma";
import type { WorkerEnv } from "./config";
import { getPeriodStart } from "./key-reset";

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
  status: string;
  expiresAt: number | null;
  updatedAt: number;
}

/**
 * 从请求中提取并验证 API Key
 *
 * @param authorizationHeader - Authorization 请求头值
 * @param db - D1 数据库绑定
 * @returns apiKey（验证通过）或 { error: Response }（验证失败）
 */
export async function validateApiKey(
  authorizationHeader: string | null,
  db: D1Database,
  env?: WorkerEnv
): Promise<{ apiKey: ApiKeyRecord } | { error: Response }> {
  let apiKeyStr: string | null = null;
  if (authorizationHeader) {
    const trimmed = authorizationHeader.trim();
    if (trimmed.startsWith("Bearer ")) {
      apiKeyStr = trimmed.slice(7).trim();
    } else {
      apiKeyStr = "";
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
    // 查询 API Key（所有限额字段在 api_keys 中）
    const apiKey = await prisma.apiKeys.findFirst({
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
        status: true,
        expiresAt: true,
        updatedAt: true,
      },
    });

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

    // 检查调用次数限制（直接使用 Key 级别 callLimit）
    const effectiveCallLimit = apiKey.callLimit ?? null;
    if (effectiveCallLimit !== null) {
      const resetPeriod = apiKey.resetPeriod ?? "never";
      const periodStart = getPeriodStart(resetPeriod);

      // 调用次数 = 未归档明细（request_logs，保留期内）+ 已归档历史（daily_stats，
      // 超过保留期被 log-archiver 聚合后从 request_logs 删除，只剩 daily_stats，
      // 两处时间窗不重叠）。此前只 count request_logs：never 周期 Key 的计数
      // 随归档"回血"（30 天前明细被删后计数下降，已达上限的 Key 被重新放行）。
      // daily_stats 同样按 periodStart 过滤（daily/monthly 周期不把周期外历史计入）
      const [recentCount, archivedAgg] = await Promise.all([
        prisma.requestLogs.count({
          where: {
            keyId: apiKey.id,
            createdAt: { gte: periodStart },
          },
        }),
        prisma.dailyStats.aggregate({
          where: {
            keyId: apiKey.id,
            date: { gte: periodStart },
          },
          _sum: { totalRequests: true },
        }),
      ]);
      const callCount = recentCount + Number(archivedAgg._sum.totalRequests ?? 0);

      if (callCount >= effectiveCallLimit) {
        return {
          error: Response.json(
            { error: { message: "API Key 调用次数已达上限", type: "rate_limit_error" } },
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

