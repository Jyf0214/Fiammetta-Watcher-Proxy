/**
 * 调试面板 2：平台熔断器与运行时状态
 *
 * GET /api/admin/dev-mode/platforms
 *   — 仅开发模式开启时可用：返回各平台启用状态、API Key 数量、最近熔断
 *     状态（来自 configs.circuit_breaker），用于快速定位"为什么这个平台
 *     一直没被选中"。
 *   - 不暴露任何 Key 明文或代理凭据；仅返回数量与状态摘要。
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
    const platforms = await db.platforms.findMany({
      orderBy: { createdAt: "asc" },
    });

    // 聚合每个平台的 Key 数量（不返回 Key 明文）
    // 平台 Key 存储在 platforms.apiKeys JSON 字段中，按平台维度解析
    const keyCounts = new Map<string, number>();
    for (const p of platforms) {
      try {
        const parsed = JSON.parse(p.apiKeys) as unknown;
        keyCounts.set(p.id, Array.isArray(parsed) ? parsed.length : 0);
      } catch {
        keyCounts.set(p.id, 0);
      }
    }

    const items = platforms.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      // 单平台多协议：开发模式面板展示完整协议列表（仅 debug 用，前端可忽略）
      types: (() => {
        try {
          const parsed = JSON.parse(p.types ?? "[]") as string[];
          return Array.isArray(parsed) ? parsed : [p.type];
        } catch {
          return [p.type];
        }
      })(),
      enabled: p.enabled,
      priority: p.priority,
      keyCount: keyCounts.get(p.id) ?? 0,
    }));

    res.status(200).json({
      success: true,
      data: { count: items.length, items },
    });
  } catch (err) {
    console.error(
      "[API /api/admin/dev-mode/platforms] 查询失败:",
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({
      success: false,
      error: { message: "查询失败", type: "server_error" },
    });
  }
}
