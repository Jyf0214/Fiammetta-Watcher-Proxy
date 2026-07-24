/**
 * GET /api/health — 健康检查
 *
 * 验证 D1 数据库连接是否正常。
 * 连接正常返回 200，连接失败返回 503（不泄露错误详情）。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const db = await createDb();
    // 执行简单查询验证数据库连接
    await db.admins.findMany({ take: 1, select: { id: true } });
    res.status(200).json({ status: "ok", database: "connected" });
  } catch {
    // 数据库连接失败时返回降级状态，不记录详细错误避免信息泄露
    res.status(503).json({ status: "degraded", database: "disconnected" });
  }
}
