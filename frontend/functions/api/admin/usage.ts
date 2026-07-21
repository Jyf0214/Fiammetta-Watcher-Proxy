/**
 * GET /api/admin/usage — 用量统计（趋势/平台维度/Key维度）
 *
 * 参数：
 * - type: "trend" | "platform" | "key"（默认 trend）
 * - period: "today" | "week" | "month" | "all"（默认 week）
 * - keyId（可选，过滤指定 Key）
 */

import { type PagesFunction } from "@cloudflare/next-on-pages";

interface Env { DB: D1Database; ENVIRONMENT?: string; }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const url = new URL(context.request.url);
  const type = url.searchParams.get("type") || "trend";
  const period = url.searchParams.get("period") || "week";
  const keyId = url.searchParams.get("keyId");

  const { dailyStats } = await import("../../../lib/schema");
  const { desc, eq: eqFn, and, gte: gteFn, sql } = await import("drizzle-orm");

  // 计算日期范围
  const now = new Date();
  let startDate: string;
  if (period === "today") {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().slice(0, 10);
  } else if (period === "week") {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    startDate = d.toISOString().slice(0, 10);
  } else if (period === "monthly") {
    const d = new Date(now);
    d.setMonth(d.getMonth() - 1);
    startDate = d.toISOString().slice(0, 10);
  } else {
    startDate = "2020-01-01";
  }
  const todayStr = now.toISOString().slice(0, 10);

  if (type === "trend") {
    const conditions = [gteFn(dailyStats.date, startDate)];
    if (keyId) conditions.push(eqFn(dailyStats.keyId, keyId));
    const where = and(...conditions);

    const rows = await db.select({
      date: dailyStats.date,
      totalRequests: sql<number>`coalesce(sum(${dailyStats.totalRequests}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${dailyStats.totalTokens}), 0)`,
    }).from(dailyStats).where(where).groupBy(dailyStats.date).orderBy(desc(dailyStats.date)).all();

    return Response.json({ success: true, data: rows });
  }

  if (type === "platform") {
    const conditions = [gteFn(dailyStats.date, startDate)];
    if (keyId) conditions.push(eqFn(dailyStats.keyId, keyId));
    const where = and(...conditions);

    const rows = await db.select({
      platformId: dailyStats.platformId,
      platformName: dailyStats.platformName,
      totalRequests: sql<number>`coalesce(sum(${dailyStats.totalRequests}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${dailyStats.totalTokens}), 0)`,
      errorRequests: sql<number>`coalesce(sum(${dailyStats.errorRequests}), 0)`,
    }).from(dailyStats).where(where).groupBy(dailyStats.platformId).orderBy(desc(sql<number>`sum(${dailyStats.totalRequests})`)).all();

    return Response.json({ success: true, data: rows });
  }

  // type === "key"
  const conditions = [gteFn(dailyStats.date, startDate)];
  if (keyId) conditions.push(eqFn(dailyStats.keyId, keyId));
  const where = and(...conditions);

  const rows = await db.select({
    keyId: dailyStats.keyId,
    keyName: dailyStats.keyName,
    totalRequests: sql<number>`coalesce(sum(${dailyStats.totalRequests}), 0)`,
    totalTokens: sql<number>`coalesce(sum(${dailyStats.totalTokens}), 0)`,
    errorRequests: sql<number>`coalesce(sum(${dailyStats.errorRequests}), 0)`,
  }).from(dailyStats).where(where).groupBy(dailyStats.keyId).orderBy(desc(sql<number>`sum(${dailyStats.totalRequests})`)).all();

  return Response.json({ success: true, data: rows });
};
