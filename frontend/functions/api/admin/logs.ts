/**
 * GET /api/admin/logs — 请求日志 + 归档日志 + 系统事件
 *
 * 参数：
 * - type: "requests" | "archive" | "events"（默认 requests）
 * - page, pageSize, keyId, platformId, model, startDate, endDate
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env { DB: D1Database; ENVIRONMENT?: string; }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const url = new URL(context.request.url);
  const type = url.searchParams.get("type") || "requests";
  const page = parseInt(url.searchParams.get("page") || "1");
  const pageSize = Math.min(parseInt(url.searchParams.get("pageSize") || "20"), 100);
  const offset = (page - 1) * pageSize;

  if (type === "events") {
    const { systemEvents } = await import("../../../lib/schema");
    const { desc } = await import("drizzle-orm");
    const rows = await db.select().from(systemEvents).orderBy(desc(systemEvents.createdAt)).limit(pageSize).offset(offset).all();
    const total = (await db.select({ total: (await import("drizzle-orm")).count() }).from(systemEvents).get())?.total ?? 0;
    return Response.json({ success: true, data: { items: rows, total, page, pageSize } });
  }

  if (type === "archive") {
    const { dailyStats } = await import("../../../lib/schema");
    const { desc, eq: eqFn, and, gte: gteFn, lte: lteFn } = await import("drizzle-orm");
    const conditions = [];
    const keyId = url.searchParams.get("keyId");
    const platformId = url.searchParams.get("platformId");
    const model = url.searchParams.get("model");
    const startDate = url.searchParams.get("startDate");
    const endDate = url.searchParams.get("endDate");
    if (keyId) conditions.push(eqFn(dailyStats.keyId, keyId));
    if (platformId) conditions.push(eqFn(dailyStats.platformId, platformId));
    if (model) conditions.push(eqFn(dailyStats.model, model));
    if (startDate) conditions.push(gteFn(dailyStats.date, startDate));
    if (endDate) conditions.push(lteFn(dailyStats.date, endDate));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = await db.select().from(dailyStats).where(where).orderBy(desc(dailyStats.date)).limit(pageSize).offset(offset).all();
    const total = (await db.select({ total: (await import("drizzle-orm")).count() }).from(dailyStats).where(where).get())?.total ?? 0;
    return Response.json({ success: true, data: { items: rows, total, page, pageSize } });
  }

  // 默认：请求日志
  const { requestLogs } = await import("../../../lib/schema");
  const { desc, eq: eqFn, and, gte: gteFn, lte: lteFn } = await import("drizzle-orm");
  const conditions = [];
  const keyId = url.searchParams.get("keyId");
  const platformId = url.searchParams.get("platformId");
  const model = url.searchParams.get("model");
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  if (keyId) conditions.push(eqFn(requestLogs.keyId, keyId));
  if (platformId) conditions.push(eqFn(requestLogs.platformId, platformId));
  if (model) conditions.push(eqFn(requestLogs.model, model));
  if (startDate) conditions.push(gteFn(requestLogs.createdAt, startDate));
  if (endDate) conditions.push(lteFn(requestLogs.createdAt, endDate));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db.select().from(requestLogs).where(where).orderBy(desc(requestLogs.createdAt)).limit(pageSize).offset(offset).all();
  const total = (await db.select({ total: (await import("drizzle-orm")).count() }).from(requestLogs).where(where).get())?.total ?? 0;
  return Response.json({ success: true, data: { items: rows, total, page, pageSize } });
};
