/**
 * GET /api/admin/devices — 获取设备注册列表
 *
 * 返回所有 device_registrations 记录，按 lastSeenAt 倒序。
 *
 * 查询参数：
 * - page: 页码，默认 1
 * - pageSize: 每页条数，默认 50，最大 100
 *
 * DELETE /api/admin/devices — 删除单条设备记录
 *   query.id: 必填，device_registrations.id
 *
 * 部署矩阵：
 *   - EdgeOne / Vercel / 本地 / Docker：正常返回数据
 *   - Cloudflare：CF 构建 alias @/lib/device-registration → stub 阻止启动期
 *     注册；本 API 在 CF 部署下仍可查询（device_registrations 表存在），但通常
 *     为空。前端页 CF 部署显示 stub 提示。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId, type AuthResult } from "@/lib/admin-auth";
import { getClientIp } from "../auth";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";

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
  // （device_registrations 表 schema 同步在 init.sql，但 CF 不发起注册）
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

    res.setHeader("Allow", "GET, DELETE");
    res.status(405).json({ success: false, error: "Method Not Allowed" });
  } catch (err) {
    console.error("[devices] 操作失败:", err);
    res.status(500).json({ success: false, error: "操作失败" });
  }
}