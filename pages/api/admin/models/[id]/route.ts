/**
 * 模型映射详情 API（Pages Functions）
 *
 * DELETE /api/admin/models/:id — 删除模型映射
 */

import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { verifyToken } from "@/lib/auth";

declare const process: { env: Record<string, string | undefined> };

/** 从 Cookie 中提取 JWT 令牌 */
function getTokenFromRequest(request: NextRequest): string | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/admin_token=([^;]+)/);
  return match ? match[1] : null;
}

/** 简单 JSON 响应 */
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * DELETE /api/admin/models/:id — 删除模型映射
 *
 * 删除前校验模型映射是否存在，删除后记录审计日志。
 * 审计日志中记录被删除映射的别名，便于追溯。
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // 1. JWT 验证
  const token = getTokenFromRequest(request);
  if (!token) {
    return jsonResponse(
      { success: false, error: { message: "未授权", type: "invalid_request_error" } },
      401,
    );
  }

  let adminId: string | null = null;
  try {
    const payload = await verifyToken(token, process.env.JWT_SECRET!);
    if (!payload) {
      return jsonResponse(
        { success: false, error: { message: "未授权", type: "invalid_request_error" } },
        401,
      );
    }
    adminId = (payload as any).adminId as string | null;
  } catch {
    return jsonResponse(
      { success: false, error: { message: "令牌无效或已过期", type: "invalid_request_error" } },
      401,
    );
  }

  // 2. 获取路径参数
  const { id } = await params;

  try {
    const db = createDb(process.env.DB as unknown as D1Database);

    // 3. 检查模型映射是否存在
    const [existing] = await db
      .select({
        id: schema.modelMappings.id,
        sourceModel: schema.modelMappings.alias,
      })
      .from(schema.modelMappings)
      .where(eq(schema.modelMappings.id, id))
      .limit(1);

    if (!existing) {
      return jsonResponse(
        { success: false, error: "模型映射不存在" },
        404,
      );
    }

    // 4. 删除模型映射
    await db
      .delete(schema.modelMappings)
      .where(eq(schema.modelMappings.id, id));

    // 5. 记录审计日志
    try {
      const now = Math.floor(Date.now() / 1000);
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
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

    return jsonResponse({
      success: true,
      message: "模型映射删除成功",
    });
  } catch (err) {
    console.error("[DELETE /api/admin/models/[id]] 删除模型映射失败:", err);
    return jsonResponse(
      { success: false, error: "删除模型映射失败" },
      500,
    );
  }
}
