/**
 * GET /api/admin/audit — 审计日志
 */

import { type PagesFunction } from "@cloudflare/next-on-pages";

interface Env { DB: D1Database; ENVIRONMENT?: string; }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const { auditLogs, admins } = await import("../../../lib/schema");
  const { desc, eq: eqFn } = await import("drizzle-orm");
  const url = new URL(context.request.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const pageSize = Math.min(parseInt(url.searchParams.get("pageSize") || "20"), 100);
  const offset = (page - 1) * pageSize;

  const rows = await db.select({
    id: auditLogs.id,
    adminId: auditLogs.adminId,
    action: auditLogs.action,
    detail: auditLogs.detail,
    ip: auditLogs.ip,
    createdAt: auditLogs.createdAt,
    adminUsername: admins.username,
  }).from(auditLogs).leftJoin(admins, eqFn(auditLogs.adminId, admins.id)).orderBy(desc(auditLogs.createdAt)).limit(pageSize).offset(offset).all();

  const total = (await db.select({ total: (await import("drizzle-orm")).count() }).from(auditLogs).get())?.total ?? 0;

  return Response.json({ success: true, data: { items: rows, total, page, pageSize } });
};
