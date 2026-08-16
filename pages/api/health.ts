/**
 * GET /api/health — 健康检查（仅管理员可见）
 *
 * 验证数据库连接是否正常，返回数据库类型和连接状态。
 * 需管理员认证（Cookie+JWT 或 Bearer system-api-key），防止未授权
 * 探测数据库类型与连接状态（部署情报泄露）。
 * 连接正常返回 200，连接失败返回 503（不泄露错误详情）。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb, getDbKind } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  // 健康检查结果不可缓存：CDN/代理缓存会掩盖部署后的真实状态
  res.setHeader("Cache-Control", "no-store");

  let dbType: string;
  try {
    dbType = await getDbKind();
  } catch {
    dbType = "unknown";
  }

  try {
    const db = await createDb();
    await db.admins.findMany({ take: 1, select: { id: true } });
    res.status(200).json({ status: "ok", database: "connected", dbType });
  } catch {
    res.status(503).json({ status: "degraded", database: "disconnected", dbType });
  }
}
