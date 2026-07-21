/**
 * GET/POST /api/admin/keys — API Key 列表（脱敏）/创建
 */

import { type PagesFunction } from "@cloudflare/next-on-pages";

interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const { apiKeys, plans } = await import("../../../lib/schema");
  const { eq } = await import("drizzle-orm");

  const rows = await db.select({
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
    planName: plans.name,
  }).from(apiKeys).leftJoin(plans, eq(apiKeys.planId, plans.id)).all();

  // 脱敏：key 仅显示前 8 位和后 4 位
  const safe = rows.map(({ key, ...rest }) => ({
    ...rest,
    key: key.length > 12 ? `${key.slice(0, 8)}...${key.slice(-4)}` : `${key.slice(0, 4)}...`,
  }));

  return Response.json({ success: true, data: safe });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const { apiKeys } = await import("../../../lib/schema");

  let body: Record<string, unknown>;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const { name, key, planId, quota, tokenLimit, callLimit, rpmLimit, tpmLimit, resetPeriod, expiresAt } = body as {
    name?: string; key?: string; planId?: string; quota?: number;
    tokenLimit?: number; callLimit?: number; rpmLimit?: number; tpmLimit?: number;
    resetPeriod?: string; expiresAt?: string;
  };

  if (!name || !key) {
    return Response.json({ success: false, error: "name 和 key 为必填项" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(apiKeys).values({
    id, key, name,
    planId: planId || null,
    quota: quota || null,
    tokenLimit: tokenLimit || null,
    callLimit: callLimit || null,
    rpmLimit: rpmLimit || null,
    tpmLimit: tpmLimit || null,
    resetPeriod: resetPeriod || "monthly",
    expiresAt: expiresAt || null,
    status: "active",
    createdAt: now,
    updatedAt: now,
  }).run();

  return Response.json({ success: true, data: { id } }, { status: 201 });
};
