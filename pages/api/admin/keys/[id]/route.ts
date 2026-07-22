/**
 * API Key 管理 — 单个 Key 操作
 *
 * GET    /api/admin/keys/[id] — 获取单个 Key 详情
 * PUT    /api/admin/keys/[id] — 更新 API Key 属性
 * DELETE /api/admin/keys/[id] — 删除 API Key（级联删除关联日志）
 *
 * 主分支对应文件：src/app/api/admin/keys/[id]/route.ts
 * 迁移变更：
 * - Prisma → Drizzle ORM (D1/SQLite)
 * - BigInt → integer, Decimal → real
 * - new Date() → Math.floor(Date.now() / 1000)
 * - $transaction → Drizzle batch/事务
 * - serializeBigInt 不再需要
 */


import { NextRequest } from "next/server";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { eq } from "drizzle-orm";
import { verifyToken } from "@/lib/auth";

/**
 * 从请求中提取管理员身份
 */
async function getAdminFromRequest(request: NextRequest): Promise<{ adminId: string; username: string } | null> {
  try {
    const token = request.cookies.get("admin_token")?.value;
    if (!token) return null;

    const payload = await verifyToken(token);
    if (!payload || !payload.adminId || !payload.username) return null;

    return { adminId: payload.adminId as string, username: payload.username as string };
  } catch {
    return null;
  }
}

/**
 * 掩码处理密钥值
 */
function maskKey(key: string): string {
  if (key.length > 12) {
    return key.substring(0, 8) + "..." + key.substring(key.length - 4);
  }
  return "***";
}

/**
 * 生成唯一 ID (UUID v4)
 */
function generateId(): string {
  return crypto.randomUUID();
}

/**
 * 获取当前 Unix 时间戳（秒）
 */
function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 从 URL 路径中提取 id 参数
 * Cloudflare Pages Functions 中需要手动解析路径
 */
function extractIdFromUrl(request: NextRequest): string | null {
  const url = new URL(request.url);
  // 路径格式: /api/admin/keys/{id}
  const segments = url.pathname.split("/").filter(Boolean);
  // ["api", "admin", "keys", "{id}"]
  if (segments.length >= 4 && segments[0] === "api" && segments[1] === "admin" && segments[2] === "keys") {
    return segments[3] || null;
  }
  return null;
}

// ==================== GET — 获取单个 Key 详情 ====================

export async function GET(request: NextRequest): Promise<Response> {
  const admin = await getAdminFromRequest(request);
  if (!admin) {
    return Response.json(
      { success: false, error: { message: "未授权", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  const id = extractIdFromUrl(request);
  if (!id) {
    return Response.json(
      { success: false, error: { message: "缺少 Key ID", type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  try {
    const db = createDb((globalThis as any).DB);

    const key = await db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, id))
      .get();

    if (!key) {
      return Response.json(
        { success: false, error: { message: "API Key 不存在", type: "invalid_request_error" } },
        { status: 404 }
      );
    }

    // 掩码处理：不返回完整密钥值
    const maskedKey = {
      ...key,
      key: maskKey(key.key),
    };

    return Response.json({
      success: true,
      data: maskedKey,
    });
  } catch (err) {
    console.error("[GET /api/admin/keys/[id]] 获取 Key 详情失败:", err instanceof Error ? err.message : String(err));
    return Response.json(
      { success: false, error: { message: "获取 Key 详情失败", type: "server_error" } },
      { status: 500 }
    );
  }
}

// ==================== PUT — 更新 API Key ====================

export async function PUT(request: NextRequest): Promise<Response> {
  const admin = await getAdminFromRequest(request);
  if (!admin) {
    return Response.json(
      { success: false, error: { message: "未授权", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  const id = extractIdFromUrl(request);
  if (!id) {
    return Response.json(
      { success: false, error: { message: "缺少 Key ID", type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  try {
    const db = createDb((globalThis as any).DB);

    // 检查 Key 是否存在
    const existing = await db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, id))
      .get();

    if (!existing) {
      return Response.json(
        { success: false, error: { message: "API Key 不存在", type: "invalid_request_error" } },
        { status: 404 }
      );
    }

    const body: any = await request.json();

    // ========== 参数校验 ==========

    // 数值类型校验（含负数检查）
    const numericFields = ["quota", "rpmLimit", "tpmLimit", "callLimit"] as const;
    for (const field of numericFields) {
      if (body[field] !== undefined && body[field] !== null) {
        if (typeof body[field] !== "number" || !Number.isFinite(body[field]) || body[field] < 0) {
          return Response.json(
            { success: false, error: { message: `${field} 必须是非负数`, type: "invalid_request_error" } },
            { status: 400 }
          );
        }
      }
    }

    // tokenLimit 为整数，单独校验
    if (body.tokenLimit !== undefined && body.tokenLimit !== null) {
      if (typeof body.tokenLimit !== "number" || !Number.isFinite(body.tokenLimit)) {
        return Response.json(
          { success: false, error: { message: "tokenLimit 必须是有效数字", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
      if (!Number.isInteger(body.tokenLimit) || body.tokenLimit < 0) {
        return Response.json(
          { success: false, error: { message: "tokenLimit 必须是非负整数", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
    }

    // name 长度校验
    if (body.name !== undefined && typeof body.name === "string" && body.name.length > 100) {
      return Response.json(
        { success: false, error: { message: "Key 名称不能超过 100 个字符", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    // status 校验
    if (body.status !== undefined) {
      const allowedStatuses = ["active", "disabled", "expired"];
      if (!allowedStatuses.includes(body.status)) {
        return Response.json(
          { success: false, error: { message: `status 无效，允许值：${allowedStatuses.join(", ")}`, type: "invalid_request_error" } },
          { status: 400 }
        );
      }
    }

    // resetPeriod 枚举校验
    if (body.resetPeriod !== undefined) {
      const validResetPeriods = ["monthly", "daily", "never"];
      if (!validResetPeriods.includes(body.resetPeriod)) {
        return Response.json(
          { success: false, error: { message: "重置周期必须是 monthly、daily 或 never", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
    }

    // planId 外键存在性校验
    if (body.planId !== undefined && body.planId !== null) {
      const planExists = await db
        .select({ id: schema.plans.id })
        .from(schema.plans)
        .where(eq(schema.plans.id, body.planId))
        .get();
      if (!planExists) {
        return Response.json(
          { success: false, error: { message: "指定的 planId 对应的套餐不存在", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
    }

    // expiresAt 日期校验
    let expiresAtTimestamp: number | null | undefined;
    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null) {
        expiresAtTimestamp = null;
      } else {
        const parsed = new Date(body.expiresAt);
        if (isNaN(parsed.getTime())) {
          return Response.json(
            { success: false, error: { message: "expiresAt 日期格式无效", type: "invalid_request_error" } },
            { status: 400 }
          );
        }
        expiresAtTimestamp = Math.floor(parsed.getTime() / 1000);
      }
    }

    // ========== 构建更新数据 ==========

    const currentTime = now();
    const updateData: Record<string, unknown> = {
      updatedAt: currentTime,
    };

    if (body.name !== undefined) updateData.name = body.name;
    if (body.planId !== undefined) updateData.planId = body.planId ?? null;
    if (body.quota !== undefined) updateData.quota = body.quota ?? null;
    if (body.rpmLimit !== undefined) updateData.rpmLimit = body.rpmLimit ?? null;
    if (body.tpmLimit !== undefined) updateData.tpmLimit = body.tpmLimit ?? null;
    if (body.callLimit !== undefined) updateData.callLimit = body.callLimit ?? null;
    if (body.tokenLimit !== undefined) updateData.tokenLimit = body.tokenLimit ?? null;
    if (body.resetPeriod !== undefined) updateData.resetPeriod = body.resetPeriod;
    if (body.status !== undefined) updateData.status = body.status;
    if (body.enabled !== undefined) updateData.enabled = body.enabled ? 1 : 0;
    if (expiresAtTimestamp !== undefined) updateData.expiresAt = expiresAtTimestamp;

    // 执行更新
    const updated = await db
      .update(schema.apiKeys)
      .set(updateData)
      .where(eq(schema.apiKeys.id, id))
      .returning()
      .get();

    // 脱敏处理 - 记录审计日志时脱敏
    const sanitizedChanges = { ...body };
    if (sanitizedChanges.key) sanitizedChanges.key = String(sanitizedChanges.key).substring(0, 8) + "***";

    // 写入审计日志
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    await db.insert(schema.auditLogs).values({
      id: generateId(),
      adminId: admin.adminId,
      action: "update_api_key",
      detail: JSON.stringify({ target: id, keyId: id, changes: sanitizedChanges }),
      ip,
      createdAt: currentTime,
    } as any);

    // 掩码处理返回数据
    const maskedUpdated = {
      ...updated,
      key: maskKey(updated.key),
    };

    return Response.json({
      success: true,
      data: maskedUpdated,
      message: "API Key 更新成功",
    });
  } catch (err) {
    console.error("[PUT /api/admin/keys/[id]] 更新失败:", err instanceof Error ? err.message : String(err));
    return Response.json(
      { success: false, error: { message: "更新 API Key 失败", type: "server_error" } },
      { status: 500 }
    );
  }
}

// ==================== DELETE — 删除 API Key ====================

export async function DELETE(request: NextRequest): Promise<Response> {
  const admin = await getAdminFromRequest(request);
  if (!admin) {
    return Response.json(
      { success: false, error: { message: "未授权", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  const id = extractIdFromUrl(request);
  if (!id) {
    return Response.json(
      { success: false, error: { message: "缺少 Key ID", type: "invalid_request_error" } },
      { status: 400 }
    );
  }

  try {
    const db = createDb((globalThis as any).DB);

    // 检查 Key 是否存在
    const existing = await db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, id))
      .get();

    if (!existing) {
      return Response.json(
        { success: false, error: { message: "API Key 不存在", type: "invalid_request_error" } },
        { status: 404 }
      );
    }

    // 先删除关联的请求日志
    const deletedLogs = await db
      .delete(schema.requestLogs)
      .where(eq(schema.requestLogs.keyId, id))
      .returning();

    // 再删除 Key
    await db
      .delete(schema.apiKeys)
      .where(eq(schema.apiKeys.id, id));

    // 写入审计日志
    const currentTime = now();
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    await db.insert(schema.auditLogs).values({
      id: generateId(),
      adminId: admin.adminId,
      action: "delete_api_key",
      detail: JSON.stringify({
        target: id,
        keyId: id,
        name: existing.name,
        deletedLogs: deletedLogs.length,
      }),
      ip,
      createdAt: currentTime,
    } as any);

    return Response.json({
      success: true,
      message: "API Key 删除成功",
      deletedLogs: deletedLogs.length,
    });
  } catch (err) {
    console.error("[DELETE /api/admin/keys/[id]] 删除失败:", err instanceof Error ? err.message : String(err));
    return Response.json(
      { success: false, error: { message: "删除 API Key 失败", type: "server_error" } },
      { status: 500 }
    );
  }
}
