/**
 * 系统级「开发模式」开关 API
 *
 * GET  /api/admin/dev-mode   — 读取当前开关状态
 * PUT  /api/admin/dev-mode   — 切换开关（审计先于写入，写后立即清缓存）
 *
 * 状态持久化于 configs.system:developer_mode；进程内 60 秒缓存
 * （见 src/lib/dev-mode.ts）。
 *
 * 调试能力接入原则：
 * - 关闭状态：所有 dev-only 端点（/api/admin/dev-mode/*）一律 403；
 * - 开启状态：返回真实数据；请求路径 console.log 详细日志；
 * - 切换必须经管理员授权，审计记录 toggle_developer_mode 事件。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { getClientIp } from "./auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import {
  DEV_MODE_CONFIG_KEY,
  parseDevMode,
  serializeDevMode,
  invalidateDevModeCache,
} from "@/lib/dev-mode";

/** configs.updatedAt 单调递增补偿（与 config.ts/notifications.ts 同语义） */
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
        where: { key: DEV_MODE_CONFIG_KEY },
        select: { value: true },
      });
      const enabled = parseDevMode(row?.value ?? null);
      res.status(200).json({ success: true, data: { enabled } });
      return;
    }

    if (req.method === "PUT") {
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;

      const body = req.body as { enabled?: unknown };
      if (typeof body.enabled !== "boolean") {
        res.status(400).json({
          success: false,
          error: {
            message: "请求体必须是 { enabled: boolean }",
            type: "invalid_request_error",
          },
        });
        return;
      }

      const value = serializeDevMode(body.enabled);
      const now = await nextConfigUpdatedAt(db, DEV_MODE_CONFIG_KEY);

      // 审计先于写入（与 config.ts/notifications.ts 同序）
      await db.auditLogs.create({
        data: {
          id: crypto.randomUUID(),
          adminId: getAuditAdminId(admin),
          action: "toggle_developer_mode",
          detail: JSON.stringify({ enabled: body.enabled }),
          ip: getClientIp(req),
          createdAt: now,
        },
      });

      await db.configs.upsert({
        where: { key: DEV_MODE_CONFIG_KEY },
        create: {
          id: crypto.randomUUID(),
          key: DEV_MODE_CONFIG_KEY,
          value,
          updatedAt: now,
        },
        update: { value, updatedAt: now },
      });

      // 写后立即清缓存，避免同进程后续请求在 TTL 窗口内仍按旧值走
      invalidateDevModeCache();

      res.status(200).json({
        success: true,
        message: body.enabled ? "开发模式已开启" : "开发模式已关闭",
        data: { enabled: body.enabled },
      });
      return;
    }

    res.setHeader("Allow", ["GET", "PUT"]);
    res.status(405).json({
      success: false,
      error: { message: "Method not allowed", type: "invalid_request_error" },
    });
  } catch (error) {
    console.error(
      "[API /api/admin/dev-mode] 操作失败:",
      error instanceof Error ? error.message : String(error)
    );
    res.status(500).json({
      success: false,
      error: { message: "操作失败", type: "server_error" },
    });
  }
}
