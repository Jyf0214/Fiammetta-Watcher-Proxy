/**
 * GET    /api/admin/devices                     — 设备注册列表（分页）
 * DELETE /api/admin/devices?id=xxx             — 删除单条设备记录
 * PATCH  /api/admin/devices                     — 更新单条设备的 warp_enabled
 *   body: { id: string, warpEnabled: boolean }
 *
 * POST   /api/admin/devices/bulk-warp           — 当前可见页批量设置 warp 启用
 *   body: { ids: string[], warpEnabled: boolean }
 *   按"仅当前可见页"原则，调用方先 GET 拿当前页 ids，再 POST 批量
 *
 * 部署矩阵：CF 部署整体 503（启动期 registerDevice alias 为 stub，设备表为空）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId, type AuthResult } from "@/lib/admin-auth";
import { getClientIp } from "../auth";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { checkCsrfOrigin } from "@/lib/admin-security";

function generateId(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // CF 部署下设备管理整体不可用（启动期 registerDevice alias 为 stub，本 API 也随之
  // 关闭）：与前端页 stub 提示保持一致，避免管理后台在 CF 部署下暴露空表
  if (process.env.DEPLOY_PLATFORM === "cf") {
    res.status(503).json({ success: false, error: "Cloudflare 部署不支持设备管理" });
    return;
  }

  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }
  // 速率限制：防止 JWT 泄露后高频轮询枚举
  if (!await checkAdminRateLimit(admin.adminId, res)) return;

  try {
    const db = await createDb();

    if (req.method === "GET") {
      const page = Math.max(1, parseInt((req.query.page as string) || "1", 10) || 1);
      const pageSize = Math.min(
        100,
        Math.max(1, parseInt((req.query.pageSize as string) || "50", 10) || 50)
      );
      const offset = (page - 1) * pageSize;

      const [items, total] = await Promise.all([
        db.deviceRegistrations.findMany({
          orderBy: { lastSeenAt: "desc" },
          skip: offset,
          take: pageSize,
        }),
        db.deviceRegistrations.count(),
      ]);

      res.status(200).json({
        success: true,
        data: {
          items: items.map((d) => ({
            id: d.id,
            deviceName: d.deviceName,
            uuid: d.uuid,
            platform: d.platform,
            address: d.address,
            appVersion: d.appVersion,
            firstSeenAt: new Date(d.firstSeenAt * 1000).toISOString(),
            lastSeenAt: new Date(d.lastSeenAt * 1000).toISOString(),
            bootCount: d.bootCount,
            warpEnabled: d.warpEnabled,
            warpEnabledAt: new Date(d.warpEnabledAt * 1000).toISOString(),
            warpEnabledBy: d.warpEnabledBy,
          })),
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
        },
      });
      return;
    }

    if (req.method === "DELETE") {
      const id = typeof req.query.id === "string" ? req.query.id : "";
      if (!id) {
        res.status(400).json({ success: false, error: "缺少 id 参数" });
        return;
      }
      // 先查存在性：避免在记录不存在时静默成功（误导操作者）
      const existing = await db.deviceRegistrations.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ success: false, error: "设备记录不存在" });
        return;
      }
      const ip = getClientIp(req);
      const currentTime = now();
      // 写审计日志：与 keys/DELETE 一致，破坏性操作留痕
      await db.auditLogs.create({
        data: {
          id: generateId(),
          adminId: getAuditAdminId(admin as AuthResult),
          action: "delete_device",
          detail: JSON.stringify({
            target: id,
            deviceId: id,
            deviceName: existing.deviceName,
            uuid: existing.uuid,
            platform: existing.platform,
          }),
          ip,
          createdAt: currentTime,
        },
      });
      await db.deviceRegistrations.delete({ where: { id } });
      return res.status(200).json({
        success: true,
        data: { id: existing.id, deviceName: existing.deviceName },
      });
    }

    if (req.method === "PATCH") {
      if (!checkCsrfOrigin(req, res)) return;
      const body = (req.body ?? {}) as { id?: unknown; warpEnabled?: unknown };
      const id = typeof body.id === "string" ? body.id : "";
      const warpEnabled = body.warpEnabled;
      if (!id) {
        res.status(400).json({ success: false, error: "缺少 id 参数" });
        return;
      }
      if (typeof warpEnabled !== "boolean") {
        res.status(400).json({ success: false, error: "warpEnabled 必须为 boolean" });
        return;
      }
      const existing = await db.deviceRegistrations.findUnique({ where: { id } });
      if (!existing) {
        res.status(404).json({ success: false, error: "设备记录不存在" });
        return;
      }
      const currentTime = now();
      const operatorId = getAuditAdminId(admin as AuthResult);
      await db.deviceRegistrations.update({
        where: { id },
        data: {
          warpEnabled,
          warpEnabledAt: currentTime,
          warpEnabledBy: operatorId,
          updatedAt: currentTime,
        },
      });
      // 写审计日志：便于追踪谁在何时切了哪台设备的 warp
      const ip = getClientIp(req);
      await db.auditLogs.create({
        data: {
          id: generateId(),
          adminId: operatorId,
          action: "toggle_device_warp",
          detail: JSON.stringify({
            target: id,
            deviceId: id,
            deviceName: existing.deviceName,
            warpEnabled,
          }),
          ip,
          createdAt: currentTime,
        },
      });
      return res.status(200).json({
        success: true,
        data: {
          id,
          deviceName: existing.deviceName,
          warpEnabled,
          warpEnabledAt: new Date(currentTime * 1000).toISOString(),
        },
      });
    }

    if (req.method === "POST" && req.query.action === "bulk-warp") {
      if (!checkCsrfOrigin(req, res)) return;
      const body = (req.body ?? {}) as { ids?: unknown; warpEnabled?: unknown };
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((x): x is string => typeof x === "string" && x.length > 0)
        : [];
      const warpEnabled = body.warpEnabled;
      if (ids.length === 0) {
        res.status(400).json({ success: false, error: "ids 不能为空" });
        return;
      }
      if (ids.length > 500) {
        res.status(400).json({ success: false, error: "单批最多 500 台" });
        return;
      }
      if (typeof warpEnabled !== "boolean") {
        res.status(400).json({ success: false, error: "warpEnabled 必须为 boolean" });
        return;
      }
      const currentTime = now();
      const operatorId = getAuditAdminId(admin as AuthResult);
      // 一次 updateMany 比逐条 update 高效：单条 SQL + 单条审计
      const result = await db.deviceRegistrations.updateMany({
        where: { id: { in: ids } },
        data: {
          warpEnabled,
          warpEnabledAt: currentTime,
          warpEnabledBy: operatorId,
          updatedAt: currentTime,
        },
      });
      const ip = getClientIp(req);
      await db.auditLogs.create({
        data: {
          id: generateId(),
          adminId: operatorId,
          action: "bulk_toggle_device_warp",
          detail: JSON.stringify({
            target: "bulk",
            count: result.count,
            ids,
            warpEnabled,
          }),
          ip,
          createdAt: currentTime,
        },
      });
      return res.status(200).json({
        success: true,
        data: { updated: result.count, warpEnabled },
      });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    res.status(405).json({ success: false, error: "Method Not Allowed" });
  } catch (err) {
    console.error("[devices] 操作失败:", err);
    res.status(500).json({ success: false, error: "操作失败" });
  }
}