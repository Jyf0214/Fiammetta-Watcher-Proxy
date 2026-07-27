/**
 * GET /api/health — 健康检查
 *
 * 验证数据库连接是否正常，返回数据库类型和连接状态。
 * 连接正常返回 200，连接失败返回 503（不泄露错误详情）。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const db = await createDb();
    await db.admins.findMany({ take: 1, select: { id: true } });
    res.status(200).json({ status: "ok", database: "connected" });
  } catch {
    res.status(503).json({ status: "degraded", database: "disconnected" });
  }
}
