/**
 * 管理后台两步验证（2FA）API
 *
 * GET  /api/admin/2fa — 查询启用状态
 * POST /api/admin/2fa — 三种操作（body.action）：
 *   begin   → 生成待确认注册信息 {secret, otpauthUri}（不落库不启用）
 *   confirm → 用该 secret 的有效验证码确认并启用
 *   disable → 校验当前验证码后关闭
 *
 * 安全语义见 src/lib/admin-2fa.ts：secret 加密落库、关闭需当前验证码。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { getClientIp } from "./auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import {
  is2faEnabled,
  beginEnrollment,
  confirmEnrollment,
  disable2fa,
} from "@/lib/admin-2fa";

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
      res.status(200).json({ success: true, data: { enabled: await is2faEnabled(db) } });
      return;
    }

    if (req.method === "POST") {
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;

      const body = req.body as { action?: string; secret?: string; code?: string };
      const code = typeof body.code === "string" ? body.code.trim() : "";

      if (body.action === "begin") {
        // 注册标签使用管理员用户名，验证器 App 列表中可辨识来源
        const username = process.env.ADMIN_USERNAME || "admin";
        res.status(200).json({ success: true, data: beginEnrollment(username) });
        return;
      }

      if (body.action === "confirm") {
        // 防换绑：已启用状态下禁止再次 confirm——被劫持的会话不能把 secret
        // 换成自备密钥（那将永久锁死原管理员）；更换必须先走 disable（需当前验证码）
        if (await is2faEnabled(db)) {
          res.status(400).json({ success: false, error: "两步验证已启用，如需更换请先关闭当前绑定" });
          return;
        }
        const secret = typeof body.secret === "string" ? body.secret.trim() : "";
        if (!secret || !code) {
          res.status(400).json({ success: false, error: "缺少 secret 或验证码" });
          return;
        }
        const ok = await confirmEnrollment(db, process.env.JWT_SECRET as string, secret, code);
        if (!ok) {
          res.status(400).json({ success: false, error: "验证码无效，请确认时间同步后重试" });
          return;
        }
        await db.auditLogs.create({
          data: {
            id: crypto.randomUUID(),
            adminId: getAuditAdminId(admin),
            action: "enable_2fa",
            detail: JSON.stringify({}),
            ip: getClientIp(req),
            createdAt: Math.floor(Date.now() / 1000),
          },
        });
        res.status(200).json({ success: true, message: "两步验证已启用" });
        return;
      }

      if (body.action === "disable") {
        if (!code) {
          res.status(400).json({ success: false, error: "请输入当前两步验证码" });
          return;
        }
        const r = await disable2fa(db, undefined, process.env.JWT_SECRET as string, code);
        if (!r.ok) {
          const msg =
            r.reason === "bad_code" ? "验证码错误"
            : r.reason === "not_enabled" ? "两步验证未启用"
            : "操作失败";
          res.status(400).json({ success: false, error: msg });
          return;
        }
        await db.auditLogs.create({
          data: {
            id: crypto.randomUUID(),
            adminId: getAuditAdminId(admin),
            action: "disable_2fa",
            detail: JSON.stringify({}),
            ip: getClientIp(req),
            createdAt: Math.floor(Date.now() / 1000),
          },
        });
        res.status(200).json({ success: true, message: "两步验证已关闭" });
        return;
      }

      res.status(400).json({ success: false, error: "未知操作" });
      return;
    }

    res.setHeader("Allow", ["GET", "POST"]);
    res.status(405).json({ success: false, error: { message: "Method not allowed", type: "invalid_request_error" } });
  } catch (error) {
    console.error("[API /api/admin/2fa] 操作失败:", error instanceof Error ? error.message : String(error));
    res.status(500).json({ success: false, error: { message: "操作失败", type: "server_error" } });
  }
}
