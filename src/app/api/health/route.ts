/**
 * GET /api/health — 健康检查
 *
 * 验证 D1 数据库连接是否正常。
 * 连接正常返回 200，连接失败返回 503（不泄露错误详情）。
 */

import { createDb } from "@/lib/db";

/** Pages Functions 环境变量绑定 */


export async function GET(
  _request: Request,
  
): Promise<Response> {
  try {
    const db = createDb(env.DB);
    // 执行简单查询验证数据库连接
    await db.get(`SELECT 1 as ok`);
    return Response.json({ status: "ok", database: "connected" });
  } catch {
    // 数据库连接失败时返回降级状态，不记录详细错误避免信息泄露
    return Response.json(
      { status: "degraded", database: "disconnected" },
      { status: 503 }
    );
  }
}
