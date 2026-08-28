/**
 * 通知发送统计端点
 *
 * GET /api/admin/notifications/stats?hours=24
 * 返回 { success, data: { windowHours, sinceSentAt, byChannel: [...] } }
 *
 * 按通道聚合最近 N 小时的 success / failed 次数、平均延迟。
 * 用于管理后台"通道健康度"展示。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";

const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 30;

interface ChannelStat {
  channelId: string;
  channelName: string;
  channelType: string;
  total: number;
  success: number;
  failed: number;
  avgDurationMs: number;
  lastSentAt: number | null;
  lastStatus: string | null;
}

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
    const hoursRaw = Number(req.query.hours ?? DEFAULT_HOURS);
    if (!Number.isFinite(hoursRaw) || hoursRaw < 1) {
      res.status(400).json({
        success: false,
        error: { message: "hours 必须是正数", type: "invalid_request_error" },
      });
      return;
    }
    const hours = Math.min(Math.floor(hoursRaw), MAX_HOURS);
    const sinceSentAt = Math.floor(Date.now() / 1000) - hours * 3600;

    const db = await createDb();
    // 一次性拉所有在窗口内的记录（小数据量，可接受；后续可加 groupBy）
    const rows = await db.notificationHistory.findMany({
      where: { sentAt: { gte: sinceSentAt } },
      orderBy: { sentAt: "desc" },
      take: 5000, // 限上限避免内存爆炸
    });

    const byChannel = new Map<string, ChannelStat>();
    for (const r of rows) {
      let stat = byChannel.get(r.channelId);
      if (!stat) {
        stat = {
          channelId: r.channelId,
          channelName: r.channelName,
          channelType: r.channelType,
          total: 0,
          success: 0,
          failed: 0,
          avgDurationMs: 0,
          lastSentAt: null,
          lastStatus: null,
        };
        byChannel.set(r.channelId, stat);
      }
      stat.total += 1;
      if (r.status === "success") stat.success += 1;
      else if (r.status === "failed") stat.failed += 1;
      stat.avgDurationMs += r.durationMs;
      // rows 已按 sentAt desc 排序，第一条就是最近
      if (stat.lastSentAt === null) {
        stat.lastSentAt = r.sentAt;
        stat.lastStatus = r.status;
      }
    }
    for (const stat of byChannel.values()) {
      stat.avgDurationMs = stat.total > 0 ? Math.round(stat.avgDurationMs / stat.total) : 0;
    }

    res.status(200).json({
      success: true,
      data: {
        windowHours: hours,
        sinceSentAt,
        byChannel: Array.from(byChannel.values()).sort(
          (a, b) => b.total - a.total
        ),
      },
    });
  } catch (err) {
    console.error(
      "[API /api/admin/notifications/stats] 操作失败:",
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({ success: false, error: { message: "操作失败", type: "server_error" } });
  }
}
