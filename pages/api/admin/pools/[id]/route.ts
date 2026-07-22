/**
 * 代理池详情 API — 单个代理池操作
 *
 * GET    /api/admin/pools/:id  — 获取单个代理池详情（含代理数量）
 * PUT    /api/admin/pools/:id  — 更新代理池（支持名称和启用状态）
 * DELETE /api/admin/pools/:id  — 删除代理池（池内代理解除关联但不删除）
 */

import { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { verifyToken } from "@/lib/auth";

declare const env: Record<string, any>;

/**
 * 验证管理员身份的通用守卫（Bearer Token 方式）
 */
async function requireAdmin(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token, (env as any).JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}

/**
 * GET /api/admin/pools/:id — 获取单个代理池详情
 *
 * 返回代理池信息及其关联的代理数量。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const admin = await requireAdmin(request);
  if (!admin) {
    return Response.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  const { id } = await params;

  try {
    const db = createDb((env as any).DB);

    const rows = await db
      .select({
        id: schema.proxyPools.id,
        name: schema.proxyPools.name,
        enabled: schema.proxyPools.enabled,
        createdAt: schema.proxyPools.createdAt,
        updatedAt: schema.proxyPools.updatedAt,
        proxyCount: sql<number>`cast(count(${schema.proxies.id}) as integer)`,
      })
      .from(schema.proxyPools)
      .leftJoin(schema.proxies, eq(schema.proxyPools.id, schema.proxies.poolId))
      .where(eq(schema.proxyPools.id, id))
      .groupBy(schema.proxyPools.id);

    if (rows.length === 0) {
      return Response.json(
        { success: false, error: "代理池不存在" },
        { status: 404 }
      );
    }

    return Response.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error("[GET /api/admin/pools/[id]] 获取代理池详情失败:", err);
    return Response.json(
      { success: false, error: "获取代理池详情失败" },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/admin/pools/:id — 更新代理池
 *
 * 可更新字段：
 * - name    (string) — 代理池名称（全局唯一，排除自身）
 * - enabled (boolean) — 是否启用
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await requireAdmin(request);
  if (!admin) {
    return Response.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  const { id } = await params;

  // 解析请求体
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "请求体格式错误" }, { status: 400 });
  }

  try {
    const db = createDb((env as any).DB);

    // 检查代理池是否存在
    const [existing] = await db
      .select({ id: schema.proxyPools.id })
      .from(schema.proxyPools)
      .where(eq(schema.proxyPools.id, id))
      .limit(1);

    if (!existing) {
      return Response.json(
        { success: false, error: "代理池不存在" },
        { status: 404 }
      );
    }

    // 构建更新数据
    const updateData: Record<string, unknown> = {};

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.trim().length === 0) {
        return Response.json(
          { success: false, error: "代理池名称不能为空" },
          { status: 400 }
        );
      }
      if (body.name.trim().length > 100) {
        return Response.json(
          { success: false, error: "代理池名称不能超过 100 个字符" },
          { status: 400 }
        );
      }
      // 检查名称唯一性（排除自身）
      const [duplicate] = await db
        .select({ id: schema.proxyPools.id })
        .from(schema.proxyPools)
        .where(eq(schema.proxyPools.name, body.name.trim()))
        .limit(1);

      if (duplicate && duplicate.id !== id) {
        return Response.json(
          { success: false, error: "代理池名称已存在" },
          { status: 400 }
        );
      }
      updateData.name = body.name.trim();
    }

    if (body.enabled !== undefined && typeof body.enabled === "boolean") {
      updateData.enabled = body.enabled;
    }

    // 无更新内容直接返回
    if (Object.keys(updateData).length === 0) {
      return Response.json({
        success: true,
        data: existing,
        message: "未检测到变更",
      });
    }

    // 更新时间戳
    updateData.updatedAt = Math.floor(Date.now() / 1000);

    // 执行更新
    await db
      .update(schema.proxyPools)
      .set(updateData)
      .where(eq(schema.proxyPools.id, id));

    // 审计日志
    try {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(schema.auditLogs).values({
        id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        adminId: String(admin.adminId || ""),
        action: "update_proxy_pool",
        detail: JSON.stringify({ poolId: id, changes: updateData }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
        createdAt: now,
      } as any);
    } catch (auditErr) {
      console.error("[PUT /api/admin/pools/:id] 审计日志写入失败:", auditErr);
    }

    // 返回更新后的数据
    const [pool] = await db
      .select()
      .from(schema.proxyPools)
      .where(eq(schema.proxyPools.id, id))
      .limit(1);

    return Response.json({
      success: true,
      data: pool,
      message: "代理池更新成功",
    });
  } catch (err) {
    console.error("[PUT /api/admin/pools/[id]] 更新代理池失败:", err);
    return Response.json(
      { success: false, error: "更新代理池失败" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/pools/:id — 删除代理池
 *
 * 删除前将池内代理的 poolId 置空（不删除代理本身），
 * 然后删除代理池，最后记录审计日志。
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const admin = await requireAdmin(request);
  if (!admin) {
    return Response.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  const { id } = await params;

  try {
    const db = createDb((env as any).DB);

    // 检查代理池是否存在
    const [existing] = await db
      .select({ id: schema.proxyPools.id, name: schema.proxyPools.name })
      .from(schema.proxyPools)
      .where(eq(schema.proxyPools.id, id))
      .limit(1);

    if (!existing) {
      return Response.json(
        { success: false, error: "代理池不存在" },
        { status: 404 }
      );
    }

    // 将池内代理的 poolId 置空（不删除代理本身）
    await db
      .update(schema.proxies)
      .set({ poolId: null, updatedAt: Math.floor(Date.now() / 1000) } as any)
      .where(eq(schema.proxies.poolId, id));

    // 删除代理池
    await db.delete(schema.proxyPools).where(eq(schema.proxyPools.id, id));

    // 审计日志
    try {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(schema.auditLogs).values({
        id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        adminId: String(admin.adminId || ""),
        action: "delete_proxy_pool",
        detail: JSON.stringify({ poolId: id, name: existing.name }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
        createdAt: now,
      } as any);
    } catch (auditErr) {
      console.error("[DELETE /api/admin/pools/:id] 审计日志写入失败:", auditErr);
    }

    return Response.json({
      success: true,
      message: "代理池删除成功",
    });
  } catch (err) {
    console.error("[DELETE /api/admin/pools/[id]] 删除代理池失败:", err);
    return Response.json(
      { success: false, error: "删除代理池失败" },
      { status: 500 }
    );
  }
}
