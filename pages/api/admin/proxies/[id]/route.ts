/**
 * 代理详情 API — 单个代理操作
 *
 * PUT    /api/admin/proxies/:id  — 更新代理（地址、启用状态、状态、关联池）
 * DELETE /api/admin/proxies/:id  — 删除代理
 */

import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { verifyToken } from "@/lib/auth";

declare const env: any;

/**
 * 内网/保留地址黑名单检查（SSRF 防护）
 */
function isDangerousHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "0.0.0.0" ||
    hostname === "127.0.0.1" ||
    /^10\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

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
 * 校验代理地址格式
 * 支持协议：http、https、socks5
 * 拒绝内网/保留地址
 */
function validateProxyAddress(address: string): string | null {
  try {
    const url = new URL(address);
    if (!["http:", "https:", "socks5:"].includes(url.protocol)) {
      return "代理地址协议必须为 http、https 或 socks5";
    }
    if (isDangerousHostname(url.hostname)) {
      return "代理地址指向内网/保留地址，出于安全考虑不被允许";
    }
    return null;
  } catch {
    return "代理地址格式无效";
  }
}

/**
 * PUT /api/admin/proxies/:id — 更新代理
 *
 * 可更新字段：
 *   - address (string)  — 代理地址（需通过协议和 SSRF 校验）
 *   - enabled (boolean) — 是否启用
 *   - status  (string)  — 状态：healthy | degraded | down
 *                          设为 healthy 时自动重置 failCount、banCount、cooldownEnd
 *   - poolId  (string|null) — 关联代理池 ID（null 表示解除关联）
 */
export async function PUT(
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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "请求体格式错误" },
      { status: 400 }
    );
  }

  try {
    const db = createDb((env as any).DB);

    // 检查代理是否存在
    const [existing] = await db
      .select({ id: schema.proxies.id })
      .from(schema.proxies)
      .where(eq(schema.proxies.id, id))
      .limit(1);

    if (!existing) {
      return Response.json(
        { success: false, error: "代理不存在" },
        { status: 404 }
      );
    }

    const updateData: Record<string, unknown> = {};

    // 校验并更新地址
    if (body.address !== undefined) {
      if (typeof body.address !== "string" || body.address.trim().length === 0) {
        return Response.json(
          { success: false, error: "代理地址不能为空" },
          { status: 400 }
        );
      }
      const addrError = validateProxyAddress(body.address.trim());
      if (addrError) {
        return Response.json(
          { success: false, error: addrError },
          { status: 400 }
        );
      }
      updateData.address = body.address.trim();
    }

    // 更新启用状态
    if (body.enabled !== undefined && typeof body.enabled === "boolean") {
      updateData.enabled = body.enabled;
    }

    // 更新状态（healthy | degraded | down）
    const VALID_STATUSES = ["healthy", "degraded", "down"];
    if (body.status !== undefined && typeof body.status === "string") {
      if (!VALID_STATUSES.includes(body.status)) {
        return Response.json(
          { success: false, error: `状态值无效，允许的值为: ${VALID_STATUSES.join(", ")}` },
          { status: 400 }
        );
      }
      updateData.status = body.status;
      // 设为 healthy 时自动重置封禁相关字段
      if (body.status === "healthy") {
        updateData.failCount = 0;
        updateData.banCount = 0;
        updateData.cooldownEnd = null;
      }
    }

    // 更新关联代理池
    if (body.poolId !== undefined) {
      if (body.poolId === null || body.poolId === "") {
        updateData.poolId = null;
      } else if (typeof body.poolId === "string") {
        const [pool] = await db
          .select({ id: schema.proxyPools.id })
          .from(schema.proxyPools)
          .where(eq(schema.proxyPools.id, body.poolId))
          .limit(1);
        if (!pool) {
          return Response.json(
            { success: false, error: "关联代理池不存在" },
            { status: 400 }
          );
        }
        updateData.poolId = body.poolId;
      }
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
      .update(schema.proxies)
      .set(updateData)
      .where(eq(schema.proxies.id, id));

    // 审计日志
    try {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(schema.auditLogs).values({
        id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        adminId: String((admin as any).adminId || (admin as any).sub || ""),
        action: "update_proxy",
        detail: JSON.stringify({ target: id, changes: updateData }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
        createdAt: now,
      } as any);
    } catch (auditErr) {
      console.error("[PUT /api/admin/proxies/:id] 审计日志写入失败:", auditErr);
    }

    // 返回更新后的数据
    const [proxy] = await db
      .select()
      .from(schema.proxies)
      .where(eq(schema.proxies.id, id))
      .limit(1);

    return Response.json({
      success: true,
      data: proxy,
      message: "代理更新成功",
    });
  } catch (err) {
    console.error("[PUT /api/admin/proxies/[id]] 更新代理失败:", err);
    return Response.json(
      { success: false, error: "更新代理失败" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/proxies/:id — 删除代理
 *
 * 直接删除代理记录。
 */
export async function DELETE(
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

    // 检查代理是否存在
    const [existing] = await db
      .select({ id: schema.proxies.id })
      .from(schema.proxies)
      .where(eq(schema.proxies.id, id))
      .limit(1);

    if (!existing) {
      return Response.json(
        { success: false, error: "代理不存在" },
        { status: 404 }
      );
    }

    // 删除代理
    await db.delete(schema.proxies).where(eq(schema.proxies.id, id));

    // 审计日志
    try {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(schema.auditLogs).values({
        id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        adminId: String((admin as any).adminId || (admin as any).sub || ""),
        action: "delete_proxy",
        detail: JSON.stringify({ target: id }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
        createdAt: now,
      } as any);
    } catch (auditErr) {
      console.error("[DELETE /api/admin/proxies/:id] 审计日志写入失败:", auditErr);
    }

    return Response.json({
      success: true,
      message: "代理删除成功",
    });
  } catch (err) {
    console.error("[DELETE /api/admin/proxies/[id]] 删除代理失败:", err);
    return Response.json(
      { success: false, error: "删除代理失败" },
      { status: 500 }
    );
  }
}
