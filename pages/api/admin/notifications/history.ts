/**
 * 通知发送历史查询端点
 *
 * GET /api/admin/notifications/history?limit=20&channelId=...&event=...&sinceSentAt=...
 * 返回 { success, data: HistoryRecord[] }
 *
 * 数据源：notificationHistory 表（与 notifier.sendNotification 共享写入）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { queryHistory, type HistoryQueryOptions } from "@/lib/notification-store";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).json({ success: false, error: { message: "Method not allowed", type: "invalid_request_error" } });
    return;
  }

  try {
    const opts: HistoryQueryOptions = {};
    const limitRaw = Number(req.query.limit ?? DEFAULT_LIMIT);
    if (!Number.isFinite(limitRaw) || limitRaw < 1) {
      res.status(400).json({
        success: false,
        error: { message: "limit 必须是正整数", type: "invalid_request_error" },
      });
      return;
    }
    opts.limit = Math.min(Math.floor(limitRaw), MAX_LIMIT);

    if (typeof req.query.channelId === "string" && req.query.channelId) {
      opts.channelId = req.query.channelId;
    }
    if (typeof req.query.event === "string" && req.query.event) {
      opts.event = req.query.event;
    }
    if (typeof req.query.sinceSentAt === "string" && req.query.sinceSentAt) {
      const since = Number(req.query.sinceSentAt);
      if (!Number.isFinite(since) || since < 0) {
        res.status(400).json({
          success: false,
          error: { message: "sinceSentAt 必须是秒级时间戳", type: "invalid_request_error" },
        });
        return;
      }
      opts.sinceSentAt = Math.floor(since);
    }

    const records = await queryHistory(opts);
    res.status(200).json({ success: true, data: records });
  } catch (err) {
    console.error(
      "[API /api/admin/notifications/history] 操作失败:",
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({ success: false, error: { message: "操作失败", type: "server_error" } });
  }
}
