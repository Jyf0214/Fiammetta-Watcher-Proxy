/**
 * GET /api/admin/audit — 获取审计日志列表
 *
 * 查询参数：
 * - page: 页码，默认 1
 * - pageSize: 每页条数，默认 20，最大 100
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }
  // 速率限制：防止 JWT 泄露后高频轮询枚举
  if (!await checkAdminRateLimit(admin.adminId, res)) return;

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

    // admins 表全项目无写入路径（登录用环境变量比对，JWT 的 adminId 为虚拟 "env-admin"），
    // 不再查询 admins 表，直接以 adminId 本身作为展示名；adminId 为 null（system-key 认证写入）时保持 null
    res.status(200).json({
      success: true,
      data: {
        items: items.map((log) => ({
          id: log.id,
          adminId: log.adminId,
          username: log.adminId ?? null,
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
    res.status(500).json({ success: false, error: "获取审计日志失败" });
  }
}
