/**
 * GET /api/admin/debug — 调试诊断（仅非生产环境）
 */

import { type PagesFunction } from "@cloudflare/next-on-pages";

interface Env { DB: D1Database; ENVIRONMENT?: string; }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  if (context.env.ENVIRONMENT === "production") {
    return Response.json({ success: false, error: "生产环境不可用" }, { status: 403 });
  }

  const db = (context.data as { db: ReturnType<typeof import("../../../lib/db").createDb> }).db;
  const { platforms, apiKeys, admins } = await import("../../../lib/schema");
  const { count } = await import("drizzle-orm");

  return Response.json({
    success: true,
    data: {
      environment: context.env.ENVIRONMENT || "unknown",
      platformCount: (await db.select({ total: count() }).from(platforms).get())?.total ?? 0,
      keyCount: (await db.select({ total: count() }).from(apiKeys).get())?.total ?? 0,
      adminCount: (await db.select({ total: count() }).from(admins).get())?.total ?? 0,
      hasJwtSecret: !!(context.env.JWT_SECRET || context.env.JWKS_KEY),
      hasAdminCredentials: !!(context.env.ADMIN_USERNAME && context.env.ADMIN_PASSWORD),
    },
  });
};
