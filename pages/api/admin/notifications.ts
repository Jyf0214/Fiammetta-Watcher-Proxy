/**
 * 告警通知配置 API
 *
 * GET /api/admin/notifications — 获取通知配置（configs.system:notifications）
 * PUT /api/admin/notifications — 全量保存（strict 校验，非法数据 400 拒绝）
 *
 * 事件触发点见 src/lib/notifier.ts 文件头；本端点只负责配置的读写与校验。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { getClientIp } from "./auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import {
  NOTIFICATIONS_CONFIG_KEY,
  parseNotificationsConfig,
  serializeNotificationsConfig,
} from "@/lib/notifier";

/** configs.updatedAt 单调递增补偿（与 config.ts nextConfigUpdatedAt 同语义） */
async function nextConfigUpdatedAt(
  db: Awaited<ReturnType<typeof createDb>>,
  key: string
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let dbUpdatedAt = 0;
  try {
    const row = await db.configs.findFirst({
      where: { key },
      select: { updatedAt: true },
    });
    dbUpdatedAt = row?.updatedAt ?? 0;
  } catch {
    // 读库失败退回自然秒值兜底，不阻断保存
  }
  return Math.max(now, dbUpdatedAt + 1);
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

  try {
    const db = await createDb();

    if (req.method === "GET") {
      const row = await db.configs.findFirst({
        where: { key: NOTIFICATIONS_CONFIG_KEY },
        select: { value: true },
      });
      const config = parseNotificationsConfig(row?.value ?? null);
      res.status(200).json({ success: true, data: config });
      return;
    }

    if (req.method === "PUT") {
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;

      const body = req.body as { config?: unknown };
      if (typeof body.config !== "object" || body.config === null || Array.isArray(body.config)) {
        res.status(400).json({
          success: false,
          error: { message: "请求体必须是 { config: {...} } 对象", type: "invalid_request_error" },
        });
        return;
      }

      let config;
      try {
        config = parseNotificationsConfig(JSON.stringify(body.config), { strict: true });
      } catch (err) {
        res.status(400).json({
          success: false,
          error: {
            message: err instanceof Error ? err.message : "通知配置校验失败",
            type: "invalid_request_error",
          },
        });
        return;
      }

      const value = serializeNotificationsConfig(config);
      const now = await nextConfigUpdatedAt(db, NOTIFICATIONS_CONFIG_KEY);

      // 审计先于写入（与 config.ts 同序）
      await db.auditLogs.create({
        data: {
          id: crypto.randomUUID(),
          adminId: getAuditAdminId(admin),
          action: "update_notifications",
          detail: JSON.stringify({
            enabled: config.enabled,
            channels: config.channels.length,
          }),
          ip: getClientIp(req),
          createdAt: now,
        },
      });

      await db.configs.upsert({
        where: { key: NOTIFICATIONS_CONFIG_KEY },
        create: {
          id: crypto.randomUUID(),
          key: NOTIFICATIONS_CONFIG_KEY,
          value,
          updatedAt: now,
        },
        update: { value, updatedAt: now },
      });

      res.status(200).json({ success: true, message: "通知配置已更新" });
      return;
    }

    res.setHeader("Allow", ["GET", "PUT"]);
    res.status(405).json({ success: false, error: { message: "Method not allowed", type: "invalid_request_error" } });
  } catch (error) {
    console.error("[API /api/admin/notifications] 操作失败:", error instanceof Error ? error.message : String(error));
    res.status(500).json({ success: false, error: { message: "操作失败", type: "server_error" } });
  }
}
