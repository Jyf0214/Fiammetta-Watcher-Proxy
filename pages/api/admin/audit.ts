/**
 * GET /api/admin/audit — 获取审计日志列表
 *
 * 查询参数：
 * - page: 页码，默认 1
 * - pageSize: 每页条数，默认 20，最大 100
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const db = await createDb();

    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt((req.query.pageSize as string) || "20", 10) || 20)
    );
    const offset = (page - 1) * pageSize;

    // 先查审计日志列表
    const [items, total] = await Promise.all([
      db.auditLogs.findMany({
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: pageSize,
      }),
      db.auditLogs.count(),
    ]);

    // 批量查询关联的管理员用户名
    const adminIds = Array.from(new Set(items.map((log) => log.adminId).filter((id): id is string => id !== null)));
    const admins = adminIds.length > 0
      ? await db.admins.findMany({ where: { id: { in: adminIds } } })
      : [];
    const adminMap = new Map(admins.map((a) => [a.id, a.username]));

    res.status(200).json({
      success: true,
      data: {
        items: items.map((log) => ({
          id: log.id,
          adminId: log.adminId,
          username: log.adminId ? adminMap.get(log.adminId) ?? null : null,
          action: log.action,
          detail: log.detail,
          ip: log.ip,
          createdAt: new Date(log.createdAt * 1000).toISOString(),
        })),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/audit] 获取审计日志失败:", err);
    res.status(500).json({ success: false, error: "获取审计日志失败", detail: err instanceof Error ? err.message : String(err) });
  }
}
