/**
 * 模型映射管理 API
 *
 * GET  /api/admin/models — 获取模型映射列表（含关联平台信息）
 * POST /api/admin/models — 创建模型映射
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { eq, desc } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { getAdminFromRequest } from "./_auth";


/**
 * GET /api/admin/models — 获取模型映射列表
 *
 * 查询所有模型映射，通过 LEFT JOIN 关联平台表，
 * 返回平台的基本信息（id、名称、状态等），按创建时间倒序排列。
 */
async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  // 1. Cookie 认证
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({
      success: false,
      error: { message: "未授权", type: "invalid_request_error" },
    });
  }

  // 2. 查询模型映射（含关联平台信息）
  try {
    const db = await createDb();

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

    return res.status(200).json({ success: true, data: models });
  } catch (err) {
    console.error("[GET /api/admin/models] 获取模型映射失败:", err);
    return res.status(500).json({ success: false, error: "获取模型映射失败" });
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
async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  // 1. Cookie 认证
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({
      success: false,
      error: { message: "未授权", type: "invalid_request_error" },
    });
  }

  // 2. 解析请求体
  const body = req.body as Record<string, unknown>;

  const sourceModel = body.sourceModel as string | undefined;
  const targetModel = body.targetModel as string | undefined;
  const platformId = (body.platformId as string | null) ?? null;
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1;

  // 3. 参数校验
  if (!sourceModel || !targetModel) {
    return res.status(400).json({
      success: false,
      error: "模型别名和目标模型不能为空",
    });
  }

  // 平台存在性校验
  if (platformId) {
    try {
      const db = await createDb();
      const [platform] = await db
        .select({ id: schema.platforms.id })
        .from(schema.platforms)
        .where(eq(schema.platforms.id, platformId))
        .limit(1);

      if (!platform) {
        return res.status(400).json({
          success: false,
          error: "指定的平台不存在",
        });
      }
    } catch (err) {
      console.error("[POST /api/admin/models] 校验平台存在性失败:", err);
      return res.status(500).json({
        success: false,
        error: "校验平台存在性失败",
      });
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
    return res.status(400).json({
      success: false,
      error: errors.join("; "),
    });
  }

  // 4. 创建模型映射
  try {
    const db = await createDb();

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
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null;
      await db.insert(schema.auditLogs).values({
        id: crypto.randomUUID(),
        adminId: admin.adminId,
        action: "create_model_map",
        detail: JSON.stringify({ modelId: model.id, sourceModel, targetModel }),
        ip,
        createdAt: now,
      } as any);
    } catch (auditErr) {
      // 审计日志写入失败不影响主流程
      console.error("[POST /api/admin/models] 审计日志写入失败:", auditErr);
    }

    return res.status(200).json({
      success: true,
      data: model,
      message: "模型映射创建成功",
    });
  } catch (err) {
    console.error("[POST /api/admin/models] 创建模型映射失败:", err);
    return res.status(500).json({ success: false, error: "创建模型映射失败" });
  }
}

/**
 * 路由分发
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
    case "GET":
      return handleGet(req, res);
    case "POST":
      return handlePost(req, res);
    default:
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).json({ success: false, error: "方法不允许" });
  }
}
