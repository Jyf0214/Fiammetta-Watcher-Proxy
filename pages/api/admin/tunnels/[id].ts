/**
 * 出站代理 — Cloudflare Tunnel 设备级管理 API
 *
 * GET    /api/admin/tunnels/[id]         — 读单台设备 tunnel 配置（token 脱敏）
 * PUT    /api/admin/tunnels/[id]         — 改单台设备 tunnelToken（body: { token: string|null }）
 * POST   /api/admin/tunnels/[id]?action=start   — 拉起本设备 cloudflared
 * POST   /api/admin/tunnels/[id]?action=stop    — 停掉本设备 cloudflared
 * POST   /api/admin/tunnels/[id]?action=reconcile — 让本设备按 token 状态自动 reconcile
 *
 * 注：[id] = device_registrations.id（不是 deviceName）；前端在 devices 页
 * 已有该 id 列表。批量操作另走 /api/admin/tunnels（无 [id]）。
 *
 * 部署矩阵：CF 部署整页 503（与 devices 一致）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId, type AuthResult } from "@/lib/admin-auth";
import { getClientIp } from "../auth";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { checkCsrfOrigin } from "@/lib/admin-security";
import {
  writeTunnelToken,
  reconcileTunnel,
  startTunnelProcess,
  stopTunnelProcess,
} from "@/lib/upstream-tunnel";

function generateId(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Token 格式校验：base64 JWT 风格，长度 ≥ 32，字符集 [A-Za-z0-9._-] */
function isValidTunnelTokenFormat(token: string): boolean {
  if (token.length < 32) return false;
  if (token.length > 4096) return false;
  return /^[A-Za-z0-9._\-=]+$/.test(token);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // CF 部署：与 devices / warp 一致，tunnel 整体不可用
  if (process.env.DEPLOY_PLATFORM === "cf") {
    res.status(503).json({ success: false, error: "Cloudflare 部署不支持 Cloudflare Tunnel" });
    return;
  }

  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }
  if (!(await checkAdminRateLimit(admin.adminId, res))) return;

  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) {
    res.status(400).json({ success: false, error: "缺少 id 参数" });
    return;
  }

  const db = await createDb();
  const existing = await db.deviceRegistrations.findUnique({ where: { id } });
  if (!existing) {
    res.status(404).json({ success: false, error: "设备记录不存在" });
    return;
  }

  try {
    if (req.method === "GET") {
      // 读脱敏后的展示态：所有数据都已在 existing 行（findUnique 拿全字段），
      // 启动时间 / 操作人 / token 摘要 直接从 existing 提取；不调 readDeviceTunnel
      //（那是查本机 device_registrations 行用，跨设备查询无意义）
      res.status(200).json({
        success: true,
        data: {
          id: existing.id,
          deviceName: existing.deviceName,
          hasToken: Boolean(existing.tunnelToken),
          tokenSummary:
            existing.tunnelToken == null
              ? null
              : `${existing.tunnelToken.slice(0, 8)}...`,
          tunnelStartedAt: existing.tunnelStartedAt,
          tunnelStartedBy: existing.tunnelStartedBy,
        },
      });
      return;
    }

    if (req.method === "PUT") {
      if (!checkCsrfOrigin(req, res)) return;
      const body = (req.body ?? {}) as { token?: unknown };
      const token = body.token;
      // token 显式 null = 清空（停 tunnel）
      if (token !== null && typeof token !== "string") {
        res.status(400).json({ success: false, error: "token 必须为 string 或 null" });
        return;
      }
      if (typeof token === "string" && !isValidTunnelTokenFormat(token)) {
        res.status(400).json({
          success: false,
          error: "token 格式无效（需 base64 JWT 风格，长度 ≥ 32）",
        });
        return;
      }
      const operatorId = getAuditAdminId(admin as AuthResult);
      await writeTunnelToken(existing.deviceName, token as string | null);
      // 写审计：detail 不含 token，仅含 deviceName + 是否有 token
      await db.auditLogs.create({
        data: {
          id: generateId(),
          adminId: operatorId,
          action: token ? "set_tunnel_token" : "clear_tunnel_token",
          detail: JSON.stringify({
            target: existing.id,
            deviceId: existing.id,
            deviceName: existing.deviceName,
            hasToken: token != null,
          }),
          ip: getClientIp(req),
          createdAt: now(),
        },
      });
      res.status(200).json({
        success: true,
        data: { id: existing.id, hasToken: token != null },
      });
      return;
    }

    if (req.method === "POST") {
      if (!checkCsrfOrigin(req, res)) return;
      const action = typeof req.query.action === "string" ? req.query.action : "";
      const operatorId = getAuditAdminId(admin as AuthResult);

      if (action === "start") {
        const token = existing.tunnelToken;
        if (!token) {
          res.status(400).json({ success: false, error: "本设备未设 tunnel token" });
          return;
        }
        if (process.env.DEPLOY_PLATFORM !== "docker") {
          res.status(400).json({
            success: false,
            error: "cloudflared 仅 Docker 部署可由本进程拉起；非 Docker 部署请在设备本机跑 cloudflared",
          });
          return;
        }
        const r = await startTunnelProcess(token, operatorId);
        await db.auditLogs.create({
          data: {
            id: generateId(),
            adminId: operatorId,
            action: "start_tunnel",
            detail: JSON.stringify({
              target: existing.id,
              deviceId: existing.id,
              deviceName: existing.deviceName,
            }),
            ip: getClientIp(req),
            createdAt: now(),
          },
        });
        res.status(200).json({ success: r.ok, data: { pid: r.pid, error: r.error } });
        return;
      }

      if (action === "stop") {
        if (process.env.DEPLOY_PLATFORM !== "docker") {
          // 非 Docker 部署：管理后台只能改 DB 状态，不能直接 kill 远端进程；
          // 但本进程的 stopTunnelProcess 仅作用于本进程 PID，安全返回 ok
        }
        const r = await stopTunnelProcess();
        await db.auditLogs.create({
          data: {
            id: generateId(),
            adminId: operatorId,
            action: "stop_tunnel",
            detail: JSON.stringify({
              target: existing.id,
              deviceId: existing.id,
              deviceName: existing.deviceName,
            }),
            ip: getClientIp(req),
            createdAt: now(),
          },
        });
        res.status(200).json({ success: r.ok, data: { error: r.error } });
        return;
      }

      if (action === "reconcile") {
        const r = await reconcileTunnel(operatorId);
        await db.auditLogs.create({
          data: {
            id: generateId(),
            adminId: operatorId,
            action: "reconcile_tunnel",
            detail: JSON.stringify({
              target: existing.id,
              deviceId: existing.id,
              deviceName: existing.deviceName,
              actionResult: r.action,
              ok: r.ok,
            }),
            ip: getClientIp(req),
            createdAt: now(),
          },
        });
        res.status(200).json({
          success: r.ok,
          data: { action: r.action, reason: r.reason, error: r.error },
        });
        return;
      }

      res.status(400).json({
        success: false,
        error: "action 必须是 start / stop / reconcile 之一",
      });
      return;
    }

    res.setHeader("Allow", "GET, PUT, POST");
    res.status(405).json({ success: false, error: "Method Not Allowed" });
  } catch (err) {
    console.error("[tunnels] 操作失败:", err);
    res.status(500).json({ success: false, error: "操作失败" });
  }
}
