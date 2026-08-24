/**
 * 失败请求留痕查看 API
 *
 * GET /api/admin/debug-log?model=<model>&at=<unix秒>
 *   — 按「模型 + 时间窗口（±120 秒）」取最近一条留痕。
 *     留痕写入与主日志写入各自独立生成 id，无外键关联；日志页以
 *     model + createdAt 传参定位同请求的留痕行（同一模型并发失败时
 *     可能取到相邻请求，正文仅供人工比对）。
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
  if (!await checkAdminRateLimit(admin.adminId, res)) return;

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).json({ success: false, error: "Method not allowed" });
    return;
  }

  try {
    const model = typeof req.query.model === "string" ? req.query.model.trim() : "";
    const at = Number(req.query.at);
    if (!model || !Number.isFinite(at) || at <= 0) {
      res.status(400).json({ success: false, error: "缺少 model 或 at 参数" });
      return;
    }

    const db = await createDb();
    const row = await db.requestDebugLogs.findFirst({
      where: {
        model,
        createdAt: { gte: at - 120, lte: at + 120 },
      },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({ success: true, data: row ?? null });
  } catch (err) {
    console.error("[GET /api/admin/debug-log] 查询失败:", err instanceof Error ? err.message : String(err));
    res.status(500).json({ success: false, error: "查询失败" });
  }
}
