/**
 * 模型映射详情 API
 *
 * DELETE /api/admin/models/:id — 删除模型映射
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { eq } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { verifyToken } from "@/lib/auth";


/**
 * DELETE /api/admin/models/:id — 删除模型映射
 *
 * 删除前校验模型映射是否存在，删除后记录审计日志。
 * 审计日志中记录被删除映射的别名，便于追溯。
 */
async function handleDelete(req: NextApiRequest, res: NextApiResponse, id: string) {
  // 1. JWT 验证
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: { message: "未授权", type: "invalid_request_error" },
    });
  }

  let adminId: string | null = null;
  try {
    const token = authHeader.slice(7);
    const payload = await verifyToken(token, process.env.JWT_SECRET!);
    if (!payload) {
      return res.status(401).json({
        success: false,
        error: { message: "未授权", type: "invalid_request_error" },
      });
    }
    adminId = (payload as any).adminId as string | null;
  } catch {
    return res.status(401).json({
      success: false,
      error: { message: "令牌无效或已过期", type: "invalid_request_error" },
    });
  }

  try {
    const db = await createDb();

    // 2. 检查模型映射是否存在
    const [existing] = await db
      .select({
        id: schema.modelMappings.id,
        sourceModel: schema.modelMappings.alias,
      })
      .from(schema.modelMappings)
      .where(eq(schema.modelMappings.id, id))
      .limit(1);

    if (!existing) {
      return res.status(404).json({ success: false, error: "模型映射不存在" });
    }

    // 3. 删除模型映射
    await db
      .delete(schema.modelMappings)
      .where(eq(schema.modelMappings.id, id));

    // 4. 记录审计日志
    try {
      const now = Math.floor(Date.now() / 1000);
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null;
      await db.insert(schema.auditLogs).values({
        id: crypto.randomUUID(),
        adminId: adminId || "",
        action: "delete_model_map",
        detail: JSON.stringify({ modelId: id, sourceModel: existing.sourceModel }),
        ip,
        createdAt: now,
      } as any);
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
    return res.status(500).json({ success: false, error: "删除模型映射失败" });
  }
}

/**
 * 路由分发
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || "");

  switch (req.method) {
    case "DELETE":
      return handleDelete(req, res, id);
    default:
      res.setHeader("Allow", ["DELETE"]);
      return res.status(405).json({ success: false, error: "方法不允许" });
  }
}
