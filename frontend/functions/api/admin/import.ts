/**
 * POST /api/admin/import — 数据导入
 */

import { type PagesFunction } from "@cloudflare/workers-types";

interface Env { DB: D1Database; KV: KVNamespace; ENVIRONMENT?: string; }

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const db = (context.data as { db: ReturnType<typeof import("../../lib/db").createDb> }).db;
  const env = (context.data as { env?: Env }).env;
  const schema = await import("../../lib/schema");

  let body: Record<string, unknown>;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ success: false, error: "请求格式错误" }, { status: 400 });
  }

  const results: Record<string, number> = {};

  // 导入平台
  if (Array.isArray(body.platforms)) {
    let count = 0;
    for (const p of body.platforms) {
      try {
        await db.insert(schema.platforms).values(p).run();
        count++;
      } catch { /* 跳过重复 */ }
    }
    results.platforms = count;
  }

  // 导入模型映射
  if (Array.isArray(body.modelMaps)) {
    let count = 0;
    for (const m of body.modelMaps) {
      try {
        await db.insert(schema.modelMaps).values(m).run();
        count++;
      } catch { /* 跳过重复 */ }
    }
    results.modelMaps = count;
  }

  // 导入代理池
  if (Array.isArray(body.proxyPools)) {
    let count = 0;
    for (const p of body.proxyPools) {
      try {
        await db.insert(schema.proxyPools).values(p).run();
        count++;
      } catch { /* 跳过重复 */ }
    }
    results.proxyPools = count;
  }

  // 导入代理
  if (Array.isArray(body.proxies)) {
    let count = 0;
    for (const p of body.proxies) {
      try {
        await db.insert(schema.proxies).values(p).run();
        count++;
      } catch { /* 跳过重复 */ }
    }
    results.proxies = count;
  }

  // 导入套餐
  if (Array.isArray(body.plans)) {
    let count = 0;
    for (const p of body.plans) {
      try {
        await db.insert(schema.plans).values(p).run();
        count++;
      } catch { /* 跳过重复 */ }
    }
    results.plans = count;
  }

  // 导入 API Keys（跳过脱敏的 key 值）
  if (Array.isArray(body.keys)) {
    let count = 0;
    for (const k of body.keys) {
      try {
        // 跳过脱敏的 key（包含 ... 的）
        if (k.key && k.key.includes("...")) continue;
        await db.insert(schema.apiKeys).values(k).run();
        count++;
      } catch { /* 跳过重复 */ }
    }
    results.keys = count;
  }

  // 导入配置
  if (body.configs && typeof body.configs === "object") {
    let count = 0;
    const now = new Date().toISOString();
    for (const [key, value] of Object.entries(body.configs as Record<string, string>)) {
      try {
        const existing = await db.select().from(schema.configs).where((await import("drizzle-orm")).eq(schema.configs.key, key)).get();
        if (existing) {
          await db.update(schema.configs).set({ value: String(value), updatedAt: now }).where((await import("drizzle-orm")).eq(schema.configs.key, key)).run();
        } else {
          await db.insert(schema.configs).values({ id: crypto.randomUUID(), key, value: String(value), updatedAt: now }).run();
        }
        count++;
      } catch { /* 跳过 */ }
    }
    results.configs = count;
  }

  return Response.json({ success: true, data: results });
};
