/**
 * 代理池管理 API
 *
 * GET  /api/admin/pools — 获取代理池列表（含每个池的代理数量）
 * POST /api/admin/pools — 创建代理池
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "./_auth";

/**
 * GET /api/admin/pools — 获取代理池列表
 *
 * 返回所有代理池，包含每个池中的代理数量（通过子查询统计），
 * 按创建时间倒序排列。
 */
async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const db = await createDb();

    // 查询所有代理池
    const pools = await db.proxyPools.findMany({
      orderBy: { createdAt: "desc" },
    });

    // 批量统计每个池的代理数量
    const proxies = await db.proxies.findMany({
      select: { poolId: true },
    });
    const countMap = new Map<string, number>();
    for (const p of proxies) {
      if (p.poolId) {
        countMap.set(p.poolId, (countMap.get(p.poolId) || 0) + 1);
      }
    }

    const data = pools.map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      proxyCount: countMap.get(p.id) || 0,
    }));

    return res.status(200).json({
      success: true,
      data,
      total: data.length,
    });
  } catch (err) {
    console.error("[GET /api/admin/pools] 获取代理池列表失败:", err);
    return res.status(500).json({ success: false, error: "获取代理池列表失败", detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * POST /api/admin/pools — 创建代理池
 *
 * 请求体参数：
 * - name (string, 必填) — 代理池名称，全局唯一
 */
async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
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
    const db = await createDb();

    // 检查名称唯一性
    const existing = await db.proxyPools.findFirst({
      where: { name: name.trim() },
      select: { id: true },
    });

    if (existing) {
      return res.status(400).json({ success: false, error: "代理池名称已存在" });
    }

    // 创建代理池
    const now = Math.floor(Date.now() / 1000);
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    await db.proxyPools.create({
      data: {
        id,
        name: name.trim(),
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    });

    // 审计日志
    try {
      await db.auditLogs.create({
        data: {
          id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          adminId: getAuditAdminId(admin),
          action: "create_proxy_pool",
          detail: JSON.stringify({ poolId: id, name: name.trim() }),
          ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
          createdAt: now,
        },
      });
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
    return res.status(500).json({ success: false, error: "创建代理池失败", detail: err instanceof Error ? err.message : String(err) });
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
