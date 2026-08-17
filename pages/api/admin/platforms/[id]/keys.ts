/**
 * 平台密钥启停 API — 单个密钥的启用/禁用操作
 *
 * PATCH /api/admin/platforms/:id/keys  body: { key: string, enabled: boolean }
 *
 * - 启用时：清零 errorCount 并设为 enabled
 * - 禁用时：设为 enabled=false（errorCount 不变）
 *
 * 注意：此路由操作的是 platforms.apiKeys JSON 字段中密钥对象的 enabled/errorCount 字段，
 * 与 Worker 内存层的临时封禁（banKey，5分钟自动恢复）不同——此处是持久化禁用。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { keyFingerprint, removePlatformKeyStatus } from "@/lib/key-status";
import { clearKeyDisabled, clearKeyCooldown, markKeyDisabled } from "../../../../../worker/src/platform-keys";

/** 生成唯一 ID（cuid 风格） */
function newId(prefix = "c"): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 安全解析 JSON 字段，默认值为指定的 fallback */
function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "PATCH") {
    res.setHeader("Allow", ["PATCH"]);
    return res.status(405).json({ success: false, error: "方法不允许" });
  }

  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }
  if (!checkCsrfOrigin(req, res)) return;

  const id = String(req.query.id || "");
  const { key: targetKey, enabled } = req.body as { key?: string; enabled?: boolean };

  if (!targetKey || typeof targetKey !== "string" || !targetKey.trim()) {
    return res.status(400).json({ success: false, error: "缺少密钥参数" });
  }
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ success: false, error: "缺少 enabled 参数" });
  }

  try {
    const db = await createDb();
    const platform = await db.platforms.findFirst({ where: { id } });
    if (!platform) {
      return res.status(404).json({ success: false, error: "平台不存在" });
    }

    const keys = safeJsonParse<Record<string, unknown>[]>(platform.apiKeys, []);
    const target = keys.find((k) => typeof k.key === "string" && k.key === targetKey);
    if (!target) {
      return res.status(404).json({ success: false, error: "密钥不存在" });
    }

    // 启用：清零错误计数
    if (enabled) {
      target.enabled = true;
      delete target.errorCount;
    } else {
      // 禁用：保留错误计数
      target.enabled = false;
    }

    const updatedJson = JSON.stringify(keys);
    const now = Math.floor(Date.now() / 1000);
    await db.platforms.update({
      where: { id },
      data: { apiKeys: updatedJson, updatedAt: now },
    });

    // 启用时同步清理内存层的 disabledKeys 与 429 临时封禁/降级冷却（即时生效），
    // 并删除 KV 中残留的 banned 记录（无 TTL，冷启动时会被恢复继续封禁）；
    // 禁用时同步标记（即时生效）
    if (enabled) {
      clearKeyDisabled(targetKey, id);
      clearKeyCooldown(targetKey, id);
      try {
        const { getCloudflareContext } = await import("@opennextjs/cloudflare");
        const kv = getCloudflareContext().env.KV as KVNamespace | undefined;
        if (kv) await removePlatformKeyStatus(kv, id, keyFingerprint(targetKey));
      } catch {
        // 本地开发或非 Cloudflare 环境没有 KV binding
      }
    } else {
      markKeyDisabled(targetKey, id);
    }

    // 审计日志（密钥只记录指纹，绝不记录内容）
    await db.auditLogs.create({
      data: {
        id: newId(),
        adminId: getAuditAdminId(admin),
        action: "toggle_platform_key",
        detail: JSON.stringify({
          platformId: id,
          keyFingerprint: keyFingerprint(targetKey),
          enabled,
        }),
        ip:
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
        createdAt: now,
      },
    });

    return res.status(200).json({
      success: true,
      message: enabled ? "密钥已启用，错误计数已清零" : "密钥已禁用",
    });
  } catch (err) {
    console.error("[PATCH /api/admin/platforms/[id]/keys] 更新密钥状态失败:", err);
    return res.status(500).json({ success: false, error: "更新密钥状态失败" });
  }
}
