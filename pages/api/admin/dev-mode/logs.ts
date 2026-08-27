/**
 * 调试面板 1：最近请求日志（详细字段）
 *
 * GET /api/admin/dev-mode/logs?minutes=60&limit=100
 *   — 仅开发模式开启时可用：返回最近 N 分钟的请求日志，含完整 status /
 *     errorMessage / keyName / proxyUrl / 客户端 IP+UA 等调试字段。
 *   - 与常规 /api/admin/logs 的差异：常规端点对前端脱敏（隐藏 IP），
 *     本端点保留全量字段供排障。
 *   - 默认窗口 60 分钟、上限 200 条；超过按时间倒序裁剪。
 *
 * 关闭开发模式：直接 403 拒绝，无任何数据返回。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { isDevMode } from "@/lib/dev-mode";

const MAX_MINUTES = 24 * 60;
const MIN_MINUTES = 1;
const MAX_LIMIT = 500;
const MIN_LIMIT = 1;
const DEFAULT_LIMIT = 100;
const DEFAULT_MINUTES = 60;

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

  // 关闭开发模式直接 403：避免常态登录管理员绕过限制看到详细日志
  const devOn = await isDevMode();
  if (!devOn) {
    res.status(403).json({
      success: false,
      error: { message: "开发模式未开启", type: "dev_mode_required" },
    });
    return;
  }

  try {
    const minutesRaw = Number(req.query.minutes ?? DEFAULT_MINUTES);
    const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT);
    const minutes = Number.isFinite(minutesRaw)
      ? Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Math.floor(minutesRaw)))
      : DEFAULT_MINUTES;
    const limit = Number.isFinite(limitRaw)
      ? Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(limitRaw)))
      : DEFAULT_LIMIT;

    const since = Math.floor(Date.now() / 1000) - minutes * 60;
    const db = await createDb();
    const rows = await db.requestLogs.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    res.status(200).json({
      success: true,
      data: {
        windowMinutes: minutes,
        limit,
        count: rows.length,
        items: rows,
      },
    });
  } catch (err) {
    console.error(
      "[API /api/admin/dev-mode/logs] 查询失败:",
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({
      success: false,
      error: { message: "查询失败", type: "server_error" },
    });
  }
}
