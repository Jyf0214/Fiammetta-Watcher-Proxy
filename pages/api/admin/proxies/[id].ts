/**
 * 代理详情 API — 单个代理操作
 *
 * PUT    /api/admin/proxies/:id  — 更新代理（地址、启用状态、状态、关联池）
 * DELETE /api/admin/proxies/:id  — 删除代理
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { eq } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { getAdminFromRequest } from "../_auth";


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
async function handlePut(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  let body: Record<string, unknown>;
  try {
    body = req.body;
  } catch {
    return res.status(400).json({ success: false, error: "请求体格式错误" });
  }

  try {
    const db = await createDb();

    // 检查代理是否存在
    const [existing] = await db
      .select({ id: schema.proxies.id })
      .from(schema.proxies)
      .where(eq(schema.proxies.id, id))
      .limit(1);

    if (!existing) {
      return res.status(404).json({ success: false, error: "代理不存在" });
    }

    const updateData: Record<string, unknown> = {};

    // 校验并更新地址
    if (body.address !== undefined) {
      if (typeof body.address !== "string" || (body.address as string).trim().length === 0) {
        return res.status(400).json({ success: false, error: "代理地址不能为空" });
      }
      const addrError = validateProxyAddress((body.address as string).trim());
      if (addrError) {
        return res.status(400).json({ success: false, error: addrError });
      }
      updateData.address = (body.address as string).trim();
    }

    // 更新启用状态
    if (body.enabled !== undefined && typeof body.enabled === "boolean") {
      updateData.enabled = body.enabled;
    }

    // 更新状态（healthy | degraded | down）
    const VALID_STATUSES = ["healthy", "degraded", "down"];
    if (body.status !== undefined && typeof body.status === "string") {
      if (!VALID_STATUSES.includes(body.status as string)) {
        return res.status(400).json({
          success: false,
          error: `状态值无效，允许的值为: ${VALID_STATUSES.join(", ")}`,
        });
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
          return res.status(400).json({ success: false, error: "关联代理池不存在" });
        }
        updateData.poolId = body.poolId;
      }
    }

    // 无更新内容直接返回
    if (Object.keys(updateData).length === 0) {
      return res.status(200).json({
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
        adminId: admin.adminId,
        action: "update_proxy",
        detail: JSON.stringify({ target: id, changes: updateData }),
        ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
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

    return res.status(200).json({
      success: true,
      data: proxy,
      message: "代理更新成功",
    });
  } catch (err) {
    console.error("[PUT /api/admin/proxies/[id]] 更新代理失败:", err);
    return res.status(500).json({ success: false, error: "更新代理失败" });
  }
}

/**
 * DELETE /api/admin/proxies/:id — 删除代理
 *
 * 直接删除代理记录。
 */
async function handleDelete(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const db = await createDb();

    // 检查代理是否存在
    const [existing] = await db
      .select({ id: schema.proxies.id })
      .from(schema.proxies)
      .where(eq(schema.proxies.id, id))
      .limit(1);

    if (!existing) {
      return res.status(404).json({ success: false, error: "代理不存在" });
    }

    // 删除代理
    await db.delete(schema.proxies).where(eq(schema.proxies.id, id));

    // 审计日志
    try {
      const now = Math.floor(Date.now() / 1000);
      await db.insert(schema.auditLogs).values({
        id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        adminId: admin.adminId,
        action: "delete_proxy",
        detail: JSON.stringify({ target: id }),
        ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
        createdAt: now,
      } as any);
    } catch (auditErr) {
      console.error("[DELETE /api/admin/proxies/:id] 审计日志写入失败:", auditErr);
    }

    return res.status(200).json({
      success: true,
      message: "代理删除成功",
    });
  } catch (err) {
    console.error("[DELETE /api/admin/proxies/[id]] 删除代理失败:", err);
    return res.status(500).json({ success: false, error: "删除代理失败" });
  }
}

/**
 * 路由分发
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || "");

  switch (req.method) {
    case "PUT":
      return handlePut(req, res, id);
    case "DELETE":
      return handleDelete(req, res, id);
    default:
      res.setHeader("Allow", ["PUT", "DELETE"]);
      return res.status(405).json({ success: false, error: "方法不允许" });
  }
}
