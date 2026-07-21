/**
 * GET /api/admin/stats — 统计信息
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env { DB: D1Database; ENVIRONMENT?: string; }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const { platforms, apiKeys, requestLogs, admins } = await import("../../../lib/schema");
  const { count, eq: eqFn, gte: gteFn } = await import("drizzle-orm");

  const platformCount = (await db.select({ total: count() }).from(platforms).get())?.total ?? 0;
  const keyCount = (await db.select({ total: count() }).from(apiKeys).where(eqFn(apiKeys.status, "active")).get())?.total ?? 0;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const todayRequests = (await db.select({ total: count() }).from(requestLogs).where(gteFn(requestLogs.createdAt, todayStart)).get())?.total ?? 0;
  const totalRequests = (await db.select({ total: count() }).from(requestLogs).get())?.total ?? 0;
  const errorRequests = (await db.select({ total: count() }).from(requestLogs).where(eqFn(requestLogs.isError, true)).get())?.total ?? 0;

  const admin = await db.select().from(admins).limit(1).get();

  return Response.json({
    success: true,
    data: {
      platformCount,
      keyCount,
      todayRequests,
      totalRequests,
      errorRequests,
      errorRate: totalRequests > 0 ? ((errorRequests / totalRequests) * 100).toFixed(1) + "%" : "0%",
      adminUsername: admin?.username || null,
    },
  });
};
