/**
 * GET /api/admin/audit — 获取审计日志列表
 *
 * 查询参数：
 * - page: 页码，默认 1
 * - pageSize: 每页条数，默认 20，最大 100
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const db = createDb((globalThis as Record<string, unknown>).DB as D1Database);

    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt((req.query.pageSize as string) || "20", 10) || 20)
    );
    const offset = (page - 1) * pageSize;

    // 关联 admins 表获取用户名
    const [items, countResult] = await Promise.all([
      db.all<{
        id: string;
        admin_id: string | null;
        action: string;
        detail: string | null;
        ip: string | null;
        created_at: number;
        username: string | null;
      }>(
        `SELECT
           a.id,
           a.admin_id,
           a.action,
           a.detail,
           a.ip,
           a.created_at,
           adm.username
         FROM audit_logs a
         LEFT JOIN admins adm ON a.admin_id = adm.id
         ORDER BY a.created_at DESC
         LIMIT ${pageSize} OFFSET ${offset}`
      ),
      db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM audit_logs`
      ),
    ]);

    const total = countResult?.count ?? 0;

    res.status(200).json({
      success: true,
      data: {
        items: items.map((log) => ({
          id: log.id,
          adminId: log.admin_id,
          username: log.username,
          action: log.action,
          detail: log.detail,
          ip: log.ip,
          createdAt: new Date(log.created_at * 1000).toISOString(),
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
