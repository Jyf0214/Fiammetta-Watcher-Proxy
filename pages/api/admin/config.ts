/**
 * 系统配置管理 API
 *
 * GET  /api/admin/config — 获取系统配置（仅 system:* 前缀）
 * PUT  /api/admin/config — 更新系统配置
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "./_auth";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: { message: "未授权", type: "invalid_request_error" } });
    return;
  }

  try {
    const db = await createDb();

    if (req.method === "GET") {
      // 查询所有 system: 前缀的配置
      const configs = await db.configs.findMany({
        where: { key: { startsWith: "system:" } },
      });

      const data: Record<string, string> = {};
      for (const c of configs) {
        data[c.key] = c.value;
      }

      res.status(200).json({ success: true, data });
      return;
    }

    if (req.method === "PUT") {
      const body = req.body as { key?: string; value?: string };

      // 验证配置键必须以 system: 开头
      if (!body.key || typeof body.key !== "string" || !body.key.startsWith("system:")) {
        res.status(400).json({ success: false, error: { message: "配置键必须以 system: 开头", type: "invalid_request_error" } });
        return;
      }

      // 验证配置值不能为空
      if (body.value === undefined || body.value === null || typeof body.value !== "string") {
        res.status(400).json({ success: false, error: { message: "配置值不能为空", type: "invalid_request_error" } });
        return;
      }

      const now = Math.floor(Date.now() / 1000);

      // 使用 Prisma upsert 实现 upsert（configs.key 是唯一约束）
      await db.configs.upsert({
        where: { key: body.key },
        create: {
          id: crypto.randomUUID(),
          key: body.key,
          value: body.value,
          updatedAt: now,
        },
        update: {
          value: body.value,
          updatedAt: now,
        },
      });

      res.status(200).json({ success: true, message: "配置已更新" });
      return;
    }

    // 不支持的 HTTP 方法
    res.setHeader("Allow", ["GET", "PUT"]);
    res.status(405).json({ success: false, error: { message: "Method not allowed", type: "invalid_request_error" } });
  } catch (error) {
    console.error(`[API /api/admin/config] 操作失败:`, error instanceof Error ? error.message : String(error));
    res.status(500).json({ success: false, error: { message: "操作失败", type: "server_error" }, detail: error instanceof Error ? error.message : String(error) });
  }
}
