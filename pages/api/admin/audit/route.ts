/**
 * GET /api/admin/audit — 获取审计日志列表
 *
 * 查询参数：
 * - page: 页码，默认 1
 * - pageSize: 每页条数，默认 20，最大 100
 */

import { NextRequest } from "next/server";
import { createDb } from "@/lib/db";

/** Pages Functions 环境变量绑定 */
interface Env {
  DB: D1Database;
}

export const runtime = "edge";

export async function GET(
  request: NextRequest,
  { env }: { env: Env }
): Promise<Response> {
  try {
    const db = createDb(env.DB);
    const { searchParams } = new URL(request.url);

    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(searchParams.get("pageSize") || "20", 10) || 20)
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

    return Response.json({
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
    return Response.json(
      { success: false, error: "获取审计日志失败" },
      { status: 500 }
    );
  }
}
