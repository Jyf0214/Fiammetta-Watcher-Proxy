/**
 * 出站代理健康检查管理 API
 *
 * GET  /api/admin/upstream-proxy/health — 获取最近一次健康度结果
 * POST /api/admin/upstream-proxy/health — 立即对所有配置的代理执行健康检查
 *
 * 仅 Docker 部署可用（代理功能本身仅 Docker 生效）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { getProxyHealth, runProxyHealthCheck } from "@/lib/upstream-proxy";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  // 代理功能仅 Docker 部署生效，其他部署形态直接拒绝
  if (process.env.DEPLOY_PLATFORM !== "docker") {
    return res.status(400).json({ success: false, error: "出站代理仅 Docker 部署可用" });
  }

  try {
    const db = await createDb();

    if (req.method === "GET") {
      const results = await getProxyHealth(db);
      return res.status(200).json({ success: true, data: { results } });
    }

    if (req.method === "POST") {
      if (!checkCsrfOrigin(req, res)) return;
      const results = await runProxyHealthCheck(db);
      return res.status(200).json({ success: true, data: { results } });
    }

    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ success: false, error: "方法不允许" });
  } catch (err) {
    console.error(
      "[API /api/admin/upstream-proxy/health] 操作失败:",
      err instanceof Error ? err.message : String(err)
    );
    return res.status(500).json({ success: false, error: "操作失败" });
  }
}