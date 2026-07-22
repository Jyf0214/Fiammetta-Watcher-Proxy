import { NextRequest } from "next/server";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { like } from "drizzle-orm";
import { verifyToken } from "@/lib/auth";

export const runtime = "edge";

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
 * GET /api/admin/config — 获取系统配置（仅 system:* 前缀）
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const admin = await getAdminFromRequest(request);
    if (!admin) {
      return Response.json(
        { success: false, error: { message: "未授权", type: "invalid_request_error" } },
        { status: 401 }
      );
    }

    const db = createDb((globalThis as any).DB as D1Database);

    // 查询所有 system: 前缀的配置
    const configs = await db
      .select()
      .from(schema.configs)
      .where(like(schema.configs.key, "system:%"));

    const data: Record<string, string> = {};
    for (const c of configs) {
      data[c.key] = c.value;
    }

    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[GET /api/admin/config] 获取系统配置失败:", error instanceof Error ? error.message : String(error));
    return Response.json(
      { success: false, error: { message: "获取系统配置失败", type: "server_error" } },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/admin/config — 更新系统配置
 * body: { key: string, value: string }
 */
export async function PUT(request: NextRequest): Promise<Response> {
  try {
    const admin = await getAdminFromRequest(request);
    if (!admin) {
      return Response.json(
        { success: false, error: { message: "未授权", type: "invalid_request_error" } },
        { status: 401 }
      );
    }

    const body: any = await request.json();
    const { key, value } = body;

    // 验证配置键必须以 system: 开头
    if (!key || typeof key !== "string" || !key.startsWith("system:")) {
      return Response.json(
        { success: false, error: { message: "配置键必须以 system: 开头", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    // 验证配置值不能为空
    if (value === undefined || value === null || typeof value !== "string") {
      return Response.json(
        { success: false, error: { message: "配置值不能为空", type: "invalid_request_error" } },
        { status: 400 }
      );
    }

    const db = createDb((globalThis as any).DB as D1Database);

    // 使用 Drizzle 的 onConflictDoUpdate 实现 upsert
    await db
      .insert(schema.configs)
      .values({
        key,
        value,
        updatedAt: Math.floor(Date.now() / 1000),
      } as any)
      .onConflictDoUpdate({
        target: schema.configs.key,
        set: {
          value,
          updatedAt: Math.floor(Date.now() / 1000),
        } as any,
      });

    return Response.json({ success: true, message: "配置已更新" });
  } catch (error) {
    console.error("[PUT /api/admin/config] 更新系统配置失败:", error instanceof Error ? error.message : String(error));
    return Response.json(
      { success: false, error: { message: "更新系统配置失败", type: "server_error" } },
      { status: 500 }
    );
  }
}
