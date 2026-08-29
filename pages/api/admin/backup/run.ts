/**
 * 立即执行一次加密备份
 *
 * POST /api/admin/backup/run
 *
 * 行为：调用 runBackupTask（与 cron /api/cron/backup 同一函数），立即构建
 * 系统配置 + 平台 + API Keys 快照，AES-GCM 加密后推送至管理后台 backup 通道
 * 或 BACKUP_WEBHOOK_URL 兜底。
 *
 * 返回 BackupTaskResult（含 success / pushed / skipped / pushedCount / failedCount /
 * sizeBytes / durationMs）。
 *
 * 鉴权：admin session（与 /api/admin/notifications 等管理端点同序）
 * CSRF：与 test.ts 同序（Origin / Referer 校验）
 * Rate limit：checkAdminRateLimit（防止管理员按钮狂点打爆下游）
 *
 * 审计：写一条 action=run_backup，含 success / pushedCount / sizeBytes / durationMs /
 * skipped 摘要（不写明文密钥）。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb, type Database } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { runBackupTask } from "@/lib/backup";
import { getClientIp } from "../auth";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ success: false, error: { message: "Method not allowed", type: "invalid_request_error" } });
    return;
  }
  if (!checkCsrfOrigin(req, res)) return;
  if (!(await checkAdminRateLimit(admin.adminId, res))) return;

  try {
    const db = await createDb();
    // runBackupTask 内部已使用 createDb() 独立访问 DB；这里只用来读库与审计
    const envObj: Record<string, unknown> = {
      DB_TYPE: process.env.DB_TYPE,
      BACKUP_WEBHOOK_URL: process.env.BACKUP_WEBHOOK_URL,
      BACKUP_ENCRYPTION_KEY: process.env.BACKUP_ENCRYPTION_KEY,
    };
    const result = await runBackupTask(db as Database, envObj);

    await (db as Database).auditLogs.create({
      data: {
        id: crypto.randomUUID(),
        adminId: getAuditAdminId(admin),
        action: "run_backup",
        detail: JSON.stringify({
          success: result.success,
          pushed: result.pushed ?? false,
          pushedCount: result.pushedCount ?? 0,
          failedCount: result.failedCount ?? 0,
          sizeBytes: result.sizeBytes ?? 0,
          durationMs: result.durationMs ?? 0,
          skipped: result.skipped ?? null,
        }),
        ip: getClientIp(req),
        createdAt: Math.floor(Date.now() / 1000),
      },
    });

    if (result.success) {
      res.status(200).json({ success: true, data: result });
      return;
    }
    // 失败（被跳过 / 所有接收端失败）：把 skipped 作为 error 字段透出
    res.status(200).json({
      success: false,
      data: result,
      error: { message: result.skipped ?? "备份执行失败", type: "backup_failed" },
    });
  } catch (err) {
    console.error(
      "[API /api/admin/backup/run] 操作失败:",
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({ success: false, error: { message: "操作失败", type: "server_error" } });
  }
}
