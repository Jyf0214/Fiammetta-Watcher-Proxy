/**
 * API Key 认证与额度检查
 *
 * 从请求 Authorization 头提取 Bearer Token，验证 Key 有效性，
 * 检查额度、过期时间、调用次数限制。
 * 同时处理 Key 用量重置周期检查。
 */

import { eq, and, gte, sql } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import {
  checkAndResetApiKey,
  getPeriodStart,
} from "./key-reset";

/**
 * API Key 查询结果类型
 *
 * D1 中没有独立的 plans 表，所有限额字段内联在 api_keys 表中。
 * quota（token 配额）、rpm_limit、tpm_limit、call_limit 直接使用 Key 级别值。
 */
export interface ApiKeyRecord {
  id: string;
  key: string;
  name: string;
  quota: number | null;
  usedTokens: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  callLimit: number | null;
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
  db: D1Database
): Promise<{ apiKey: ApiKeyRecord } | { error: Response }> {
  const apiKeyStr = authorizationHeader?.replace("Bearer ", "");

  if (!apiKeyStr) {
    return {
      error: Response.json(
        { error: { message: "缺少 API Key", type: "invalid_request_error" } },
        { status: 401 }
      ),
    };
  }

  const orm = await createDb(db);

  // 查询 API Key（D1 无 plans 表，所有限额字段在 api_keys 中）
  const rows = await orm
    .select({
      id: schema.apiKeys.id,
      key: schema.apiKeys.key,
      name: schema.apiKeys.name,
      quota: schema.apiKeys.quota,
      usedTokens: schema.apiKeys.usedTokens,
      rpmLimit: schema.apiKeys.rpmLimit,
      tpmLimit: schema.apiKeys.tpmLimit,
      callLimit: schema.apiKeys.callLimit,
      callUsed: schema.apiKeys.callUsed,
      resetPeriod: schema.apiKeys.resetPeriod,
      status: schema.apiKeys.status,
      expiresAt: schema.apiKeys.expiresAt,
      updatedAt: schema.apiKeys.updatedAt,
    })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.key, apiKeyStr))
    .limit(1);

  if (rows.length === 0 || rows[0].status !== "active") {
    return {
      error: Response.json(
        { error: { message: "无效的 API Key", type: "invalid_request_error" } },
        { status: 401 }
      ),
    };
  }

  const apiKey = rows[0];

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

  // 检查是否需要重置用量（调用 key-reset.ts 的统一实现）
  await checkAndResetApiKey(db, apiKey.id);

  // 检查调用次数限制（D1 无 plans 表，直接使用 Key 级别 callLimit）
  const effectiveCallLimit = apiKey.callLimit ?? null;
  if (effectiveCallLimit !== null) {
    const resetPeriod = apiKey.resetPeriod ?? "never";
    const periodStart = getPeriodStart(resetPeriod);

    const callCountResult = await orm
      .select({ count: sql<number>`count(*)` })
      .from(schema.requestLogs)
      .where(
        and(
          eq(schema.requestLogs.keyId, apiKey.id),
          gte(schema.requestLogs.createdAt, periodStart)
        )
      );

    const callCount = callCountResult[0]?.count ?? 0;
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

