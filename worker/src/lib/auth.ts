/**
 * API Key 验证与重置模块 — Worker 代理专用
 *
 * 包含代理请求所需的核心逻辑：
 * - validateApiKey：验证 API Key 状态、过期时间、调用次数
 * - checkAndResetApiKey：按 resetPeriod 在线重置 usedTokens（每次请求时检查）
 *
 * Admin JWT 认证、密码哈希等功能由 Cloudflare Pages Functions 处理。
 */

import type { Env } from "../types";
import { createDb } from "../db";
import { apiKeys, plans, requestLogs } from "../db/schema";
import { eq, and, gte, count } from "drizzle-orm";

// ==================== 类型 ====================

/** API Key 查询结果（带 plan 关联） */
export interface ApiKeyWithPlan {
  id: string;
  key: string;
  name: string;
  planId: string | null;
  quota: number | null;
  usedTokens: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  callLimit: number | null;
  tokenLimit: number | null;
  resetPeriod: string;
  status: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  plan: {
    id: string;
    name: string;
    tokenQuota: number;
    callLimit: number;
    rpmLimit: number;
    tpmLimit: number;
    resetPeriod: string;
  } | null;
}

// ==================== API Key 用量重置 ====================

/**
 * 判断 API Key 是否需要在当前周期重置
 *
 * 使用 updatedAt 字段判断：如果上次更新日期与当前日期不在同一周期，则需要重置。
 */
function needsReset(apiKey: { resetPeriod: string | null; updatedAt: string }): boolean {
  const now = new Date();
  const updated = new Date(apiKey.updatedAt);

  switch (apiKey.resetPeriod) {
    case "daily":
      return updated.toDateString() !== now.toDateString();
    case "monthly":
      return (
        updated.getMonth() !== now.getMonth() ||
        updated.getFullYear() !== now.getFullYear()
      );
    case "never":
    default:
      return false;
  }
}

/**
 * 检查单个 API Key 是否需要重置，并在必要时执行重置
 *
 * 在每次请求验证 API Key 后调用，确保用量及时归零。
 * 返回 true 表示已执行重置，false 表示无需重置。
 */
export async function checkAndResetApiKey(
  db: ReturnType<typeof createDb>,
  apiKeyId: string
): Promise<boolean> {
  try {
    const apiKey = await db
      .select({
        id: apiKeys.id,
        resetPeriod: apiKeys.resetPeriod,
        usedTokens: apiKeys.usedTokens,
        status: apiKeys.status,
        updatedAt: apiKeys.updatedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))
      .get();

    if (!apiKey || !needsReset(apiKey)) {
      return false;
    }

    // 计算当前周期的起始时间（清理过期请求日志，使 callLimit 同步重置）
    const now = new Date();
    let periodStart: string;
    if (apiKey.resetPeriod === "daily") {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      periodStart = d.toISOString();
    } else {
      // monthly: 从当月1号开始
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      periodStart = d.toISOString();
    }

    // 执行重置：归零 usedTokens、清理过期请求日志、恢复 status
    // D1 不支持事务，分步执行（极端情况下可能不原子，但可接受）
    await db
      .update(apiKeys)
      .set({
        usedTokens: 0,
        // 如果因超限被禁用，在新周期自动恢复
        ...(apiKey.status === "disabled" ? { status: "active" } : {}),
      })
      .where(eq(apiKeys.id, apiKeyId));

    await db
      .delete(requestLogs)
      .where(
        and(
          eq(requestLogs.keyId, apiKeyId),
          gte(requestLogs.createdAt, periodStart)
        )
      );

    return true;
  } catch (error) {
    console.error(
      `[api-key-reset] 检查重置失败 (keyId=${apiKeyId}):`,
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

// ==================== API Key 验证 ====================

/**
 * 从请求中提取并验证 API Key
 *
 * 查询 apiKeys 表 + plans 表，检查状态、过期时间、调用次数限制。
 *
 * @param db Drizzle 数据库实例
 * @param env Cloudflare 环境绑定
 * @param authorizationHeader Authorization 请求头的值
 * @returns apiKey（验证通过）或 { error: Response }（验证失败）
 */
export async function validateApiKey(
  db: ReturnType<typeof createDb>,
  _env: Env,
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

  // 查询 API Key（带 plan 关联）
  const apiKeyRow = await db
    .select({
      id: apiKeys.id,
      key: apiKeys.key,
      name: apiKeys.name,
      planId: apiKeys.planId,
      quota: apiKeys.quota,
      usedTokens: apiKeys.usedTokens,
      rpmLimit: apiKeys.rpmLimit,
      tpmLimit: apiKeys.tpmLimit,
      callLimit: apiKeys.callLimit,
      tokenLimit: apiKeys.tokenLimit,
      resetPeriod: apiKeys.resetPeriod,
      status: apiKeys.status,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
      updatedAt: apiKeys.updatedAt,
      plan: {
        id: plans.id,
        name: plans.name,
        tokenQuota: plans.tokenQuota,
        callLimit: plans.callLimit,
        rpmLimit: plans.rpmLimit,
        tpmLimit: plans.tpmLimit,
        resetPeriod: plans.resetPeriod,
      },
    })
    .from(apiKeys)
    .leftJoin(plans, eq(apiKeys.planId, plans.id))
    .where(eq(apiKeys.key, apiKeyStr))
    .get();

  if (!apiKeyRow || apiKeyRow.status !== "active") {
    return {
      error: Response.json(
        { error: { message: "无效的 API Key", type: "invalid_request_error" } },
        { status: 401 }
      ),
    };
  }

  // 检查过期时间
  if (apiKeyRow.expiresAt) {
    const now = new Date();
    const expiresAt = new Date(apiKeyRow.expiresAt);
    if (expiresAt < now) {
      return {
        error: Response.json(
          { error: { message: "API Key 已过期", type: "invalid_request_error" } },
          { status: 401 }
        ),
      };
    }
  }

  // 检查调用次数限制（callLimit），仅统计当前重置周期内的调用次数
  const effectiveCallLimit = apiKeyRow.callLimit ?? apiKeyRow.plan?.callLimit ?? null;
  if (effectiveCallLimit !== null) {
    const now = new Date();
    let periodStart: string;
    const resetPeriod = apiKeyRow.resetPeriod ?? apiKeyRow.plan?.resetPeriod ?? "never";

    if (resetPeriod === "daily") {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      periodStart = d.toISOString();
    } else if (resetPeriod === "monthly") {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      periodStart = d.toISOString();
    } else {
      periodStart = new Date(0).toISOString();
    }

    const result = await db
      .select({ total: count() })
      .from(requestLogs)
      .where(
        and(
          eq(requestLogs.keyId, apiKeyRow.id),
          gte(requestLogs.createdAt, periodStart)
        )
      )
      .get();

    const callCount = result?.total ?? 0;
    if (callCount >= effectiveCallLimit) {
      return {
        error: Response.json(
          { error: { message: "API Key 调用次数已达上限", type: "invalid_request_error" } },
          { status: 429 }
        ),
      };
    }
  }

  return { apiKey: apiKeyRow as ApiKeyWithPlan };
}
