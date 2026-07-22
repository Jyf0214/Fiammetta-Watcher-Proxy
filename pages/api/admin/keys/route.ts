/**
 * API Key 管理 — 列表与创建
 *
 * GET  /api/admin/keys — 获取 API Key 列表（含套餐信息，密钥掩码处理）
 * POST /api/admin/keys — 创建新 API Key
 *
 * 主分支对应文件：src/app/api/admin/keys/route.ts
 * 迁移变更：
 * - Prisma → Drizzle ORM (D1/SQLite)
 * - BigInt → integer, Decimal → real
 * - new Date() → Math.floor(Date.now() / 1000) (Unix 时间戳)
 * - crypto.randomBytes → Web Crypto API (Edge Runtime 兼容)
 * - serializeBigInt 不再需要（SQLite 直接存储整数/浮点数）
 */

export const runtime = "edge";

import { NextRequest } from "next/server";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { eq, desc } from "drizzle-orm";
import { verifyToken } from "@/lib/auth";

/**
 * 从请求中提取管理员身份
 * 从 Cookie 中读取 admin_token 并验证 JWT
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
 * 完整密钥 sk-xxxxxxxx...yyyy  → sk-xxxx****yyyy
 * 短密钥 → ***
 */
function maskKey(key: string): string {
  if (key.length > 12) {
    return key.substring(0, 8) + "..." + key.substring(key.length - 4);
  }
  return "***";
}

/**
 * 使用 Web Crypto API 生成 API Key
 * 格式：sk-{48个十六进制字符}（24 字节随机数据）
 */
function generateApiKey(): string {
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  const hex = Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sk-${hex}`;
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

// ==================== GET — 获取 API Key 列表 ====================

export async function GET(request: NextRequest): Promise<Response> {
  const admin = await getAdminFromRequest(request);
  if (!admin) {
    return Response.json(
      { success: false, error: { message: "未授权", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  try {
    const db = createDb((globalThis as any).DB);

    // 查询所有 Key，按创建时间倒序
    const keys = await db
      .select()
      .from(schema.apiKeys)
      .orderBy(desc(schema.apiKeys.createdAt));

    // 掩码处理：列表接口不返回完整密钥值
    const maskedKeys = keys.map((k) => ({
      ...k,
      key: maskKey(k.key),
    }));

    return Response.json({
      success: true,
      data: maskedKeys,
      total: maskedKeys.length,
    });
  } catch (err) {
    console.error("[GET /api/admin/keys] 获取 Key 列表失败:", err instanceof Error ? err.message : String(err));
    return Response.json(
      { success: false, error: { message: "获取 Key 列表失败", type: "server_error" } },
      { status: 500 }
    );
  }
}

// ==================== POST — 创建 API Key ====================

export async function POST(request: NextRequest): Promise<Response> {
  const admin = await getAdminFromRequest(request);
  if (!admin) {
    return Response.json(
      { success: false, error: { message: "未授权", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  try {
    const body: any = await request.json();
    const {
      name,
      planId,
      quota,
      rpmLimit,
      tpmLimit,
      callLimit,
      tokenLimit,
      resetPeriod,
      expiresAt,
    } = body;

    // ========== 参数校验 ==========

    // name 必填且长度限制
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return Response.json(
        { success: false, error: { message: "Key 名称不能为空", type: "invalid_request_error" } },
        { status: 400 }
      );
    }
    if (name.length > 100) {
      return Response.json(
        { success: false, error: { message: "Key 名称不能超过 100 个字符", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    // resetPeriod 枚举校验
    const validResetPeriods = ["monthly", "daily", "never"];
    if (resetPeriod && !validResetPeriods.includes(resetPeriod)) {
      return Response.json(
        { success: false, error: { message: "重置周期必须是 monthly、daily 或 never", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    // 数值字段校验
    if (quota !== undefined && quota !== null) {
      if (typeof quota !== "number" || !Number.isFinite(quota) || quota < 0) {
        return Response.json(
          { success: false, error: { message: "配额必须是非负数", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
    }
    if (rpmLimit !== undefined && rpmLimit !== null) {
      if (typeof rpmLimit !== "number" || !Number.isFinite(rpmLimit) || rpmLimit < 0) {
        return Response.json(
          { success: false, error: { message: "RPM 限制必须是非负数", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
    }
    if (tpmLimit !== undefined && tpmLimit !== null) {
      if (typeof tpmLimit !== "number" || !Number.isFinite(tpmLimit) || tpmLimit < 0) {
        return Response.json(
          { success: false, error: { message: "TPM 限制必须是非负数", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
    }
    if (callLimit !== undefined && callLimit !== null) {
      if (typeof callLimit !== "number" || !Number.isFinite(callLimit) || callLimit < 0) {
        return Response.json(
          { success: false, error: { message: "调用次数限制必须是非负数", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
    }
    if (tokenLimit !== undefined && tokenLimit !== null) {
      if (typeof tokenLimit !== "number" || !Number.isInteger(tokenLimit) || tokenLimit < 0) {
        return Response.json(
          { success: false, error: { message: "Token 限制必须是非负整数", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
    }

    // planId 外键存在性校验
    if (planId !== undefined && planId !== null) {
      const db = createDb((globalThis as any).DB);
      const planExists = await db
        .select({ id: schema.plans.id })
        .from(schema.plans)
        .where(eq(schema.plans.id, planId))
        .get();
      if (!planExists) {
        return Response.json(
          { success: false, error: { message: "指定的 planId 对应的套餐不存在", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
    }

    // expiresAt 日期校验
    let expiresAtTimestamp: number | null = null;
    if (expiresAt) {
      const parsed = new Date(expiresAt);
      if (isNaN(parsed.getTime())) {
        return Response.json(
          { success: false, error: { message: "expiresAt 日期格式无效", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
      expiresAtTimestamp = Math.floor(parsed.getTime() / 1000);
    }

    // ========== 创建 Key ==========

    const db = createDb((globalThis as any).DB);
    const keyId = generateId();
    const keyValue = generateApiKey();
    const currentTime = now();

    const newKey = await db
      .insert(schema.apiKeys)
      .values({
        id: keyId,
        key: keyValue,
        name: name.trim(),
        planId: planId ?? null,
        quota: quota ?? null,
        usedTokens: 0,
        rpmLimit: rpmLimit ?? null,
        tpmLimit: tpmLimit ?? null,
        callLimit: callLimit ?? null,
        callUsed: 0,
        tokenLimit: tokenLimit ?? null,
        resetPeriod: resetPeriod || "monthly",
        status: "active",
        expiresAt: expiresAtTimestamp,
        enabled: true,
        createdAt: currentTime,
        updatedAt: currentTime,
      } as any)
      .returning()
      .get();

    // 写入审计日志
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    await db.insert(schema.auditLogs).values({
      id: generateId(),
      adminId: admin.adminId,
      action: "create_api_key",
      detail: JSON.stringify({ target: keyId, keyId, name: name.trim() }),
      ip,
      createdAt: currentTime,
    } as any);

    return Response.json({
      success: true,
      data: newKey,
      message: "API Key 创建成功",
    });
  } catch (err) {
    console.error("[POST /api/admin/keys] 创建 Key 失败:", err instanceof Error ? err.message : String(err));
    return Response.json(
      { success: false, error: { message: "创建 Key 失败", type: "server_error" } },
      { status: 500 }
    );
  }
}
