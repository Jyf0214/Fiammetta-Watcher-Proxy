/**
 * 出站代理列表拉取管理 API
 *
 * POST /api/admin/upstream-proxy/pull — 立即对配置了拉取源的组执行代理列表拉取
 *
 * 仅 Docker 部署可用（代理功能本身仅 Docker 生效）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { pullProxyGroups } from "@/lib/upstream-proxy";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // 认证优先于一切检查（与 health.ts 一致），避免未授权请求探测路由行为
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  // 代理功能仅 Docker 部署生效，其他部署形态直接拒绝
  if (process.env.DEPLOY_PLATFORM !== "docker") {
    return res.status(400).json({ success: false, error: "出站代理仅 Docker 部署可用" });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ success: false, error: "方法不允许" });
  }

  if (!checkCsrfOrigin(req, res)) return;

  try {
    const db = await createDb();
    const results = await pullProxyGroups(db);
    return res.status(200).json({ success: true, data: { results } });
  } catch (err) {
    console.error(
      "[API /api/admin/upstream-proxy/pull] 操作失败:",
      err instanceof Error ? err.message : String(err)
    );
    return res.status(500).json({ success: false, error: "操作失败" });
  }
}