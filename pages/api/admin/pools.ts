/**
 * 代理池管理 API
 *
 * GET  /api/admin/pools — 获取代理池列表（含每个池的代理数量）
 * POST /api/admin/pools — 创建代理池
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { eq, desc, sql } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { verifyToken } from "@/lib/auth";


/**
 * 验证管理员身份的通用守卫（Bearer Token 方式）
 */
async function requireAdmin(req: NextApiRequest) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token, process.env.JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}

/**
 * GET /api/admin/pools — 获取代理池列表
 *
 * 返回所有代理池，包含每个池中的代理数量（通过子查询统计），
 * 按创建时间倒序排列。
 */
async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const db = createDb((process.env as unknown as { DB: D1Database }).DB);

    // 使用 LEFT JOIN + COUNT 获取每个池的代理数量
    const pools = await db
      .select({
        id: schema.proxyPools.id,
        name: schema.proxyPools.name,
        enabled: schema.proxyPools.enabled,
        createdAt: schema.proxyPools.createdAt,
        updatedAt: schema.proxyPools.updatedAt,
        proxyCount: sql<number>`cast(count(${schema.proxies.id}) as integer)`,
      })
      .from(schema.proxyPools)
      .leftJoin(schema.proxies, eq(schema.proxyPools.id, schema.proxies.poolId))
      .groupBy(schema.proxyPools.id)
      .orderBy(desc(schema.proxyPools.createdAt));

    return res.status(200).json({
      success: true,
      data: pools,
      total: pools.length,
    });
  } catch (err) {
    console.error("[GET /api/admin/pools] 获取代理池列表失败:", err);
    return res.status(500).json({ success: false, error: "获取代理池列表失败" });
  }
}

/**
 * POST /api/admin/pools — 创建代理池
 *
 * 请求体参数：
 * - name (string, 必填) — 代理池名称，全局唯一
 */
async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  // 解析请求体
  const body = req.body as Record<string, unknown>;

  const name = body.name as string | undefined;

  // 参数校验
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return res.status(400).json({ success: false, error: "代理池名称不能为空" });
  }

  if (name.trim().length > 100) {
    return res.status(400).json({ success: false, error: "代理池名称不能超过 100 个字符" });
  }

  try {
    const db = createDb((process.env as unknown as { DB: D1Database }).DB);

    // 检查名称唯一性
    const [existing] = await db
      .select({ id: schema.proxyPools.id })
      .from(schema.proxyPools)
      .where(eq(schema.proxyPools.name, name.trim()))
      .limit(1);

    if (existing) {
      return res.status(400).json({ success: false, error: "代理池名称已存在" });
    }

    // 创建代理池
    const now = Math.floor(Date.now() / 1000);
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    await db.insert(schema.proxyPools).values({
      id,
      name: name.trim(),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    } as any);

    // 审计日志
    try {
      await db.insert(schema.auditLogs).values({
        id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        adminId: String((admin as any).adminId || (admin as any).sub || ""),
        action: "create_proxy_pool",
        target: JSON.stringify({ poolId: id, name: name.trim() }),
        ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
        createdAt: now,
      } as any);
    } catch (auditErr) {
      console.error("[POST /api/admin/pools] 审计日志写入失败:", auditErr);
    }

    return res.status(200).json({
      success: true,
      data: { id, name: name.trim(), enabled: true, createdAt: now, updatedAt: now },
      message: "代理池创建成功",
    });
  } catch (err) {
    console.error("[POST /api/admin/pools] 创建代理池失败:", err);
    return res.status(500).json({ success: false, error: "创建代理池失败" });
  }
}

/**
 * 路由分发
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
    case "GET":
      return handleGet(req, res);
    case "POST":
      return handlePost(req, res);
    default:
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).json({ success: false, error: "方法不允许" });
  }
}
