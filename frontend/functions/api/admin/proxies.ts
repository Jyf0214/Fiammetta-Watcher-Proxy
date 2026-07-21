/**
 * GET/POST /api/admin/proxies — 代理列表/创建/批量导入
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env { DB: D1Database; ENVIRONMENT?: string; }

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const { proxies } = await import("../../lib/schema");
  const { desc } = await import("drizzle-orm");
  const rows = await db.select().from(proxies).orderBy(desc(proxies.createdAt)).all();
  return Response.json({ success: true, data: rows });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const { proxies } = await import("../../lib/schema");

  let body: Record<string, unknown>;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  // 批量导入
  if (Array.isArray(body.addresses)) {
    const { addresses, poolId } = body as { addresses: string[]; poolId?: string };
    const now = new Date().toISOString();
    const values = addresses.map((addr) => ({
      id: crypto.randomUUID(), address: addr, poolId: poolId || null,
      status: "healthy", createdAt: now, updatedAt: now,
    }));
    // 逐个插入（D1 不支持批量 INSERT OR IGNORE）
    for (const v of values) {
      await db.insert(proxies).values(v).run();
    }
    return Response.json({ success: true, data: { imported: values.length } }, { status: 201 });
  }

  // 单个创建
  const { address, poolId } = body as { address?: string; poolId?: string };
  if (!address) {
    return Response.json({ success: false, error: "address 为必填项" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(proxies).values({ id, address, poolId: poolId || null, status: "healthy", createdAt: now, updatedAt: now }).run();
  return Response.json({ success: true, data: { id } }, { status: 201 });
};
