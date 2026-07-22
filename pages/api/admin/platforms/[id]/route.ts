/**
 * 平台管理 CRUD API — 单个平台操作
 *
 * GET    /api/admin/platforms/:id  — 获取单个平台详情
 * PUT    /api/admin/platforms/:id  — 更新平台（支持部分字段更新）
 * DELETE /api/admin/platforms/:id  — 删除平台（需先清理关联数据）
 */

import { NextRequest } from "next/server";
import { createDb } from "@/lib/db";
import { verifyToken } from "@/lib/auth";
import * as schema from "@/lib/schema";
import { eq } from "drizzle-orm";

declare const env: Record<string, any>;

/** 安全解析 JSON 字段，默认值为指定的 fallback */
function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * GET /api/admin/platforms/:id — 获取单个平台详情（包含 apiKeys 用于编辑回填）
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return Response.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const token = authHeader.slice(7);
    await verifyToken(token, (env as any).JWT_SECRET);

    const db = createDb((env as any).DB);
    const rows = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.id, id))
      .limit(1);

    if (rows.length === 0) {
      return Response.json(
        { success: false, error: "平台不存在" },
        { status: 404 }
      );
    }

    const platform = rows[0];

    // 解析 JSON 字段为结构化数据，方便前端编辑
    const apiKeys = safeJsonParse<string[]>(platform.apiKeys, []);
    const forwardHeaders = safeJsonParse<string[]>(
      platform.forwardHeaders,
      []
    );

    return Response.json({
      success: true,
      data: {
        ...platform,
        apiKeys,
        forwardHeaders,
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/platforms/[id]] 获取平台失败:", err);
    return Response.json(
      { success: false, error: "获取平台失败" },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/admin/platforms/:id — 更新平台
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return Response.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const token = authHeader.slice(7);
    const admin = await verifyToken(token, (env as any).JWT_SECRET);

    const body: any = await request.json();

    // 字段类型校验
    const errors: string[] = [];

    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      errors.push("enabled 必须为布尔值");
    }

    if (body.weight !== undefined) {
      if (
        typeof body.weight !== "number" ||
        !Number.isInteger(body.weight) ||
        body.weight <= 0
      ) {
        errors.push("权重必须为正整数");
      }
    }

    if (body.priority !== undefined) {
      if (
        typeof body.priority !== "number" ||
        !Number.isInteger(body.priority) ||
        body.priority < 0
      ) {
        errors.push("优先级必须为非负整数");
      }
    }

    // SSRF 防护：校验 baseUrl 格式及内网地址黑名单
    if (body.baseUrl !== undefined) {
      if (
        typeof body.baseUrl !== "string" ||
        body.baseUrl.trim().length === 0
      ) {
        errors.push("基础 URL 不能为空");
      } else {
        try {
          const url = new URL(body.baseUrl);
          if (!["http:", "https:"].includes(url.protocol)) {
            errors.push("URL 协议必须是 http 或 https");
          }
          const hostname = url.hostname;
          if (
            hostname === "localhost" ||
            hostname === "0.0.0.0" ||
            hostname === "127.0.0.1" ||
            /^10\./.test(hostname) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
            /^192\.168\./.test(hostname) ||
            /^169\.254\./.test(hostname) ||
            hostname === "[::1]" ||
            hostname === "::1"
          ) {
            errors.push("URL 不能指向内网或本地地址");
          }
        } catch {
          errors.push("URL 格式不合法");
        }
      }
    }

    const VALID_PLATFORM_TYPES = ["openai", "azure", "custom"] as const;
    if (
      body.type !== undefined &&
      !VALID_PLATFORM_TYPES.includes(body.type)
    ) {
      errors.push(
        `平台类型无效，允许的值为: ${VALID_PLATFORM_TYPES.join(", ")}`
      );
    }

    if (
      body.name !== undefined &&
      typeof body.name === "string" &&
      body.name.length > 100
    ) {
      errors.push("平台名称不能超过 100 个字符");
    }

    if (
      body.apiKey !== undefined &&
      typeof body.apiKey === "string" &&
      body.apiKey.length > 500
    ) {
      errors.push("API Key 不能超过 500 个字符");
    }

    if (errors.length > 0) {
      return Response.json(
        { success: false, error: errors.join("; ") },
        { status: 400 }
      );
    }

    const db = createDb((env as any).DB);

    // 获取现有平台数据，用于编辑时保留未修改的字段
    const existingRows = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.id, id))
      .limit(1);

    if (existingRows.length === 0) {
      return Response.json(
        { success: false, error: "平台不存在" },
        { status: 404 }
      );
    }
    const existing = existingRows[0];

    // 构建更新数据（仅包含传入的字段）
    const updateData: Record<string, unknown> = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.baseUrl !== undefined) updateData.base_url = body.baseUrl;
    if (body.type !== undefined) updateData.type = body.type;
    if (body.enabled !== undefined)
      updateData.enabled = body.enabled ? 1 : 0;
    if (body.priority !== undefined) updateData.priority = body.priority;
    if (body.weight !== undefined) updateData.weight = body.weight;
    if (body.rpmLimit !== undefined)
      updateData.rpm_limit = body.rpmLimit ?? null;
    if (body.tpmLimit !== undefined)
      updateData.tpm_limit = body.tpmLimit ?? null;

    // forwardHeaders 校验并更新
    if (body.forwardHeaders !== undefined) {
      if (body.forwardHeaders === "" || body.forwardHeaders === null) {
        updateData.forward_headers = "[]";
      } else if (typeof body.forwardHeaders === "string") {
        try {
          const parsed = JSON.parse(body.forwardHeaders);
          if (Array.isArray(parsed)) {
            const validHeaders = parsed
              .filter(
                (h: unknown): h is string =>
                  typeof h === "string" && h.trim().length > 0
              )
              .map((h: string) => h.trim());
            updateData.forward_headers = JSON.stringify(validHeaders);
          }
        } catch {
          // JSON 解析失败，保留原值
        }
      }
    }

    // apiKey 在编辑时可选（不提供则保留原值）
    if (body.apiKey === undefined || body.apiKey === null || body.apiKey === "") {
      // 不更新 apiKey
    } else {
      updateData.api_key = body.apiKey;
    }

    // apiKeys 在编辑时可选（不提供则保留原值）
    // 支持两种格式：字符串数组 ["key1", "key2"] 或对象数组 [{name, key}]
    if (body.apiKeys !== undefined && body.apiKeys !== null) {
      if (body.apiKeys === "") {
        updateData.api_keys = "[]";
      } else if (typeof body.apiKeys === "string") {
        try {
          const parsed = JSON.parse(body.apiKeys);
          if (Array.isArray(parsed)) {
            // 检查是否为对象数组格式 [{name, key}]
            if (
              parsed.length > 0 &&
              typeof parsed[0] === "object" &&
              parsed[0] !== null &&
              "key" in parsed[0]
            ) {
              // 命名密钥格式
              const validKeys = parsed.filter(
                (k: unknown): k is { name: string; key: string } =>
                  typeof k === "object" &&
                  k !== null &&
                  typeof (k as any).key === "string" &&
                  (k as any).key.trim().length > 0 &&
                  (k as any).key.length <= 500
              );
              updateData.api_keys = JSON.stringify(validKeys);
            } else {
              // 旧格式：字符串数组
              const validKeys = parsed.filter(
                (k: unknown): k is string =>
                  typeof k === "string" &&
                  k.trim().length > 0 &&
                  k.length <= 500
              );
              updateData.api_keys = JSON.stringify(validKeys);
            }
          }
        } catch {
          // JSON 解析失败，保留原值
        }
      }
    }

    // 无任何更新字段时直接返回
    if (Object.keys(updateData).length === 0) {
      return Response.json({
        success: true,
        data: existing,
        message: "未检测到变更",
      });
    }

    // 更新时间戳
    updateData.updated_at = Math.floor(Date.now() / 1000);

    await db
      .update(schema.platforms)
      .set(updateData)
      .where(eq(schema.platforms.id, id));

    // 审计日志（脱敏处理）
    const sanitized = { ...body };
    if (sanitized.apiKey)
      sanitized.apiKey = sanitized.apiKey.substring(0, 6) + "***";

    const now = Math.floor(Date.now() / 1000);
    await db.insert(schema.auditLogs).values({
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      adminId: String((admin as any).adminId || (admin as any).sub || ""),
      action: "update_platform",
      detail: JSON.stringify({ platformId: id, changes: sanitized }),
      ip:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      createdAt: now,
    } as any);

    // 返回更新后的数据
    const updatedRows = await db
      .select()
      .from(schema.platforms)
      .where(eq(schema.platforms.id, id))
      .limit(1);

    return Response.json({
      success: true,
      data: updatedRows[0],
      message: "平台更新成功",
    });
  } catch (err) {
    console.error("[PUT /api/admin/platforms/[id]] 更新平台失败:", err);
    return Response.json(
      { success: false, error: "更新平台失败" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/platforms/:id — 删除平台
 *
 * 删除前校验：
 * - 检查是否被模型映射（model_mappings）引用，被引用时拒绝删除
 * - 清理关联的请求日志和平台模型
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return Response.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const token = authHeader.slice(7);
    const admin = await verifyToken(token, (env as any).JWT_SECRET);

    const db = createDb((env as any).DB);

    // 检查是否存在关联的 model_mappings 记录
    const relatedMappings = await db
      .select()
      .from(schema.model_mappings)
      .where(eq(schema.modelMappings.platformId, id));

    if (relatedMappings.length > 0) {
      return Response.json(
        {
          success: false,
          error: `该平台被 ${relatedMappings.length} 个模型映射引用，无法删除。请先删除相关映射。`,
        },
        { status: 400 }
      );
    }

    // 统计并清理关联数据
    // 删除关联的请求日志
    await db
      .delete(schema.request_logs)
      .where(eq(schema.requestLogs.platformId, id));

    // 删除关联的平台模型
    await db
      .delete(schema.platform_models)
      .where(eq(schema.platformModels.platformId, id));

    // 删除平台本身
    await db.delete(schema.platforms).where(eq(schema.platforms.id, id));

    // 审计日志
    const now = Math.floor(Date.now() / 1000);
    await db.insert(schema.auditLogs).values({
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      adminId: String((admin as any).adminId || (admin as any).sub || ""),
      action: "delete_platform",
      detail: JSON.stringify({ platformId: id }),
      ip:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      createdAt: now,
    } as any);

    return Response.json({
      success: true,
      message: "平台删除成功",
    });
  } catch (err) {
    console.error("[DELETE /api/admin/platforms/[id]] 删除平台失败:", err);
    return Response.json(
      { success: false, error: "删除平台失败" },
      { status: 500 }
    );
  }
}
