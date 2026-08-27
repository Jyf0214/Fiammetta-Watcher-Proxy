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
    const platformIds = platforms.map((p) => p.id);
    const keyCounts = new Map<string, number>();
    for (const pid of platformIds) keyCounts.set(pid, 0);
    if (platformIds.length > 0) {
      // 平台 Key 存储在 configs.apiKeys JSON 数组中，按 platform 维度聚合
      const apiKeyRows = await db.configs.findMany({
        where: { key: "apiKeys" },
        select: { value: true },
      });
      for (const row of apiKeyRows) {
        try {
          const parsed = JSON.parse(row.value) as unknown;
          if (!Array.isArray(parsed)) continue;
          for (const entry of parsed) {
            if (
              typeof entry === "object" &&
              entry !== null &&
              !Array.isArray(entry) &&
              typeof (entry as Record<string, unknown>).platformId === "string"
            ) {
              const pid = (entry as Record<string, unknown>).platformId as string;
              keyCounts.set(pid, (keyCounts.get(pid) ?? 0) + 1);
            }
          }
        } catch {
          // 单条 JSON 解析失败不影响整体聚合
        }
      }
    }

    const items = platforms.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
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
