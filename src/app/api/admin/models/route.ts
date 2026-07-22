/**
 * 模型映射管理 API（Pages Functions）
 *
 * GET  /api/admin/models — 获取模型映射列表（含关联平台信息）
 * POST /api/admin/models — 创建模型映射
 */

import { NextRequest } from "next/server";
import { eq, desc } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { verifyToken } from "@/lib/auth";


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
 * GET /api/admin/models — 获取模型映射列表
 *
 * 查询所有模型映射，通过 LEFT JOIN 关联平台表，
 * 返回平台的基本信息（id、名称、状态等），按创建时间倒序排列。
 */
export async function GET(request: NextRequest) {
  // 1. JWT 验证
  const token = getTokenFromRequest(request);
  if (!token) {
    return jsonResponse(
      { success: false, error: { message: "未授权", type: "invalid_request_error" } },
      401,
    );
  }

  try {
    const payload = await verifyToken(token, process.env.JWT_SECRET!);
    if (!payload) {
      return jsonResponse(
        { success: false, error: { message: "未授权", type: "invalid_request_error" } },
        401,
      );
    }
  } catch {
    return jsonResponse(
      { success: false, error: { message: "令牌无效或已过期", type: "invalid_request_error" } },
      401,
    );
  }

  // 2. 查询模型映射（含关联平台信息）
  try {
    const db = createDb((process.env as unknown as { DB: D1Database }).DB);

    const models = await db
      .select({
        id: schema.modelMappings.id,
        sourceModel: schema.modelMappings.alias,
        targetModel: schema.modelMappings.targetModel,
        platformId: schema.modelMappings.platformId,
        createdAt: schema.modelMappings.createdAt,
        // 关联平台信息
        platform: {
          id: schema.platforms.id,
          name: schema.platforms.name,
          baseUrl: schema.platforms.baseUrl,
          type: schema.platforms.type,
          enabled: schema.platforms.enabled,
          priority: schema.platforms.priority,
          weight: schema.platforms.weight,
          status: schema.platforms.status,
          failCount: schema.platforms.failCount,
          lastFailAt: schema.platforms.lastFailAt,
          cooldownEnd: schema.platforms.cooldownEnd,
          createdAt: schema.platforms.createdAt,
          updatedAt: schema.platforms.updatedAt,
        },
      })
      .from(schema.modelMappings)
      .leftJoin(
        schema.platforms,
        eq(schema.modelMappings.platformId, schema.platforms.id),
      )
      .orderBy(desc(schema.modelMappings.createdAt));

    return jsonResponse({ success: true, data: models });
  } catch (err) {
    console.error("[GET /api/admin/models] 获取模型映射失败:", err);
    return jsonResponse(
      { success: false, error: "获取模型映射失败" },
      500,
    );
  }
}

/**
 * POST /api/admin/models — 创建模型映射
 *
 * 请求体参数：
 * - sourceModel  (string, 必填) — 客户端请求的模型名（别名）
 * - targetModel  (string, 必填) — 实际转发到上游的模型名
 * - platformId   (string, 可选) — 绑定到特定平台（null 表示使用路由引擎自动选择）
 * - enabled      (boolean, 可选) — 是否启用（默认 true）
 *
 * 验证规则：
 * - sourceModel 不能超过 100 个字符
 * - targetModel 不能超过 200 个字符
 * - platformId 如提供，必须对应已存在的平台
 */
export async function POST(request: NextRequest) {
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

  // 2. 解析请求体
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      { success: false, error: "请求体格式错误" },
      400,
    );
  }

  const sourceModel = body.sourceModel as string | undefined;
  const targetModel = body.targetModel as string | undefined;
  const platformId = (body.platformId as string | null) ?? null;
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1;

  // 3. 参数校验
  if (!sourceModel || !targetModel) {
    return jsonResponse(
      { success: false, error: "模型别名和目标模型不能为空" },
      400,
    );
  }

  // 平台存在性校验
  if (platformId) {
    try {
      const db = createDb((process.env as unknown as { DB: D1Database }).DB);
      const [platform] = await db
        .select({ id: schema.platforms.id })
        .from(schema.platforms)
        .where(eq(schema.platforms.id, platformId))
        .limit(1);

      if (!platform) {
        return jsonResponse(
          { success: false, error: "指定的平台不存在" },
          400,
        );
      }
    } catch (err) {
      console.error("[POST /api/admin/models] 校验平台存在性失败:", err);
      return jsonResponse(
        { success: false, error: "校验平台存在性失败" },
        500,
      );
    }
  }

  // 字符串长度校验
  const errors: string[] = [];
  if (typeof sourceModel === "string" && sourceModel.length > 100) {
    errors.push("模型别名不能超过 100 个字符");
  }
  if (typeof targetModel === "string" && targetModel.length > 200) {
    errors.push("目标模型名称不能超过 200 个字符");
  }
  if (errors.length > 0) {
    return jsonResponse(
      { success: false, error: errors.join("; ") },
      400,
    );
  }

  // 4. 创建模型映射
  try {
    const db = createDb((process.env as unknown as { DB: D1Database }).DB);

    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();

    const [model] = await db
      .insert(schema.modelMappings)
      .values({
        id,
        alias: sourceModel,
        targetModel,
        platformId: platformId || "",
        createdAt: now,
      } as any)
      .returning();

    // 5. 记录审计日志
    try {
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
      await db.insert(schema.auditLogs).values({
        id: crypto.randomUUID(),
        adminId: adminId || "",
        action: "create_model_map",
        detail: JSON.stringify({ modelId: model.id, sourceModel, targetModel }),
        ip,
        createdAt: now,
      } as any);
    } catch (auditErr) {
      // 审计日志写入失败不影响主流程
      console.error("[POST /api/admin/models] 审计日志写入失败:", auditErr);
    }

    return jsonResponse({
      success: true,
      data: model,
      message: "模型映射创建成功",
    });
  } catch (err) {
    console.error("[POST /api/admin/models] 创建模型映射失败:", err);
    return jsonResponse(
      { success: false, error: "创建模型映射失败" },
      500,
    );
  }
}
