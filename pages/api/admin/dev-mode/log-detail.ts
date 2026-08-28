/**
 * 调试面板 3：单条请求日志详情
 *
 * GET /api/admin/dev-mode/log-detail?id=<requestLogId>
 *   — 仅开发模式开启时可用：返回某条请求日志的完整字段（含 errorMessage
 *     完整内容、ipAddress、userAgent、proxyUrl），与 logs 列表端的脱敏
 *     摘要不同。本端点专为排障设计，不做重放（重放风险高、需重新走完整
 *     路由+鉴权+计费链路，不在本调试面板范围内）。
 *
 * 关闭开发模式：直接 403 拒绝。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { isDevMode } from "@/lib/dev-mode";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).json({
      success: false,
      error: { message: "Method not allowed", type: "invalid_request_error" },
    });
    return;
  }

  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }

  if (!(await checkAdminRateLimit(admin.adminId, res))) return;

  const id =
    typeof req.query.id === "string" ? req.query.id.trim() : "";
  if (!id) {
    res.status(400).json({
      success: false,
      error: { message: "缺少 id 参数", type: "invalid_request_error" },
    });
    return;
  }

  const devOn = await isDevMode();
  if (!devOn) {
    res.status(403).json({
      success: false,
      error: { message: "开发模式未开启", type: "dev_mode_required" },
    });
    return;
  }

  try {
    const db = await createDb();
    const row = await db.requestLogs.findFirst({ where: { id } });
    if (!row) {
      res.status(404).json({
        success: false,
        error: { message: "日志不存在", type: "not_found" },
      });
      return;
    }
    res.status(200).json({ success: true, data: row });
  } catch (err) {
    console.error(
      "[API /api/admin/dev-mode/log-detail] 查询失败:",
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({
      success: false,
      error: { message: "查询失败", type: "server_error" },
    });
  }
}
