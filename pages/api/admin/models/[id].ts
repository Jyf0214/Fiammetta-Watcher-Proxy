/**
 * 模型映射详情 API
 *
 * PATCH  /api/admin/models/:id — 切换模型映射启用状态
 * DELETE /api/admin/models/:id — 删除模型映射
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "../_auth";


/**
 * PATCH /api/admin/models/:id — 切换模型映射启用状态
 *
 * 请求体：{ enabled: boolean }
 */
async function handlePatch(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({
      success: false,
      error: { message: "未授权", type: "invalid_request_error" },
    });
  }

  const { enabled } = req.body as { enabled?: boolean };
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ success: false, error: "enabled 字段必须为布尔值" });
  }

  try {
    const db = await createDb();
    const existing = await db.modelMappings.findFirst({
      where: { id },
      select: { id: true, alias: true, enabled: true },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "模型映射不存在" });
    }

    const now = Math.floor(Date.now() / 1000);
    await db.modelMappings.update({
      where: { id },
      data: { enabled, updatedAt: now },
    });

    // 审计日志
    try {
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null;
      await db.auditLogs.create({
        data: {
          id: crypto.randomUUID(),
          adminId: getAuditAdminId(admin),
          action: enabled ? "enable_model_map" : "disable_model_map",
          detail: JSON.stringify({ modelId: id, sourceModel: existing.alias }),
          ip,
          createdAt: now,
        },
      });
    } catch {
      // 审计日志失败不影响主流程
    }

    return res.status(200).json({
      success: true,
      message: enabled ? "模型映射已启用" : "模型映射已禁用",
    });
  } catch (err) {
    console.error("[PATCH /api/admin/models/[id]] 切换模型映射状态失败:", err);
    return res.status(500).json({ success: false, error: "切换模型映射状态失败", detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * DELETE /api/admin/models/:id — 删除模型映射
 *
 * 删除前校验模型映射是否存在，删除后记录审计日志。
 * 审计日志中记录被删除映射的别名，便于追溯。
 */
async function handleDelete(req: NextApiRequest, res: NextApiResponse, id: string) {
  // 1. Cookie 认证
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({
      success: false,
      error: { message: "未授权", type: "invalid_request_error" },
    });
  }

  try {
    const db = await createDb();

    // 2. 检查模型映射是否存在
    const existing = await db.modelMappings.findFirst({
      where: { id },
      select: { id: true, alias: true },
    });

    if (!existing) {
      return res.status(404).json({ success: false, error: "模型映射不存在" });
    }

    // 3. 删除模型映射
    await db.modelMappings.delete({ where: { id } });

    // 4. 记录审计日志
    try {
      const now = Math.floor(Date.now() / 1000);
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null;
      await db.auditLogs.create({
        data: {
          id: crypto.randomUUID(),
          adminId: getAuditAdminId(admin),
          action: "delete_model_map",
          detail: JSON.stringify({ modelId: id, sourceModel: existing.alias }),
          ip,
          createdAt: now,
        },
      });
    } catch (auditErr) {
      // 审计日志写入失败不影响主流程
      console.error("[DELETE /api/admin/models/:id] 审计日志写入失败:", auditErr);
    }

    return res.status(200).json({
      success: true,
      message: "模型映射删除成功",
    });
  } catch (err) {
    console.error("[DELETE /api/admin/models/[id]] 删除模型映射失败:", err);
    return res.status(500).json({ success: false, error: "删除模型映射失败", detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * 路由分发
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || "");

  switch (req.method) {
    case "PATCH":
      return handlePatch(req, res, id);
    case "DELETE":
      return handleDelete(req, res, id);
    default:
      res.setHeader("Allow", ["PATCH", "DELETE"]);
      return res.status(405).json({ success: false, error: "方法不允许" });
  }
}
