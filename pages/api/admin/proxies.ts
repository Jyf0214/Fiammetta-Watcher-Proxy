/**
 * 代理管理 API — 列表和创建
 *
 * GET  /api/admin/proxies  — 获取代理列表（支持 poolId 过滤，含封禁状态计算）
 * POST /api/admin/proxies  — 创建代理（带地址校验和 SSRF 防护）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "./_auth";


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
    return null; // 校验通过
  } catch {
    return "代理地址格式无效";
  }
}

/**
 * GET /api/admin/proxies — 获取代理列表
 *
 * 查询参数：
 *   - poolId?: string — 按代理池 ID 过滤
 *
 * 返回数据包含关联的代理池名称，以及实时封禁状态（isBanned）。
 */
async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const poolId = req.query.poolId as string | undefined;

    const db = await createDb();

    // 查询代理列表
    const proxies = await db.proxies.findMany({
      where: poolId ? { poolId } : undefined,
      orderBy: { createdAt: "desc" },
    });

    // 收集所有关联的 poolId，批量查询代理池名称
    const poolIds = [...new Set(proxies.map((p) => p.poolId).filter(Boolean))] as string[];
    const pools = poolIds.length > 0
      ? await db.proxyPools.findMany({ where: { id: { in: poolIds } } })
      : [];
    const poolNameMap = new Map(pools.map((p) => [p.id, p.name]));

    // 组装返回数据
    const data = proxies.map((p) => ({
      id: p.id,
      address: p.address,
      poolId: p.poolId,
      enabled: p.enabled,
      status: p.status,
      failCount: p.failCount,
      banCount: p.banCount,
      lastFailAt: p.lastFailAt,
      cooldownEnd: p.cooldownEnd,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      poolName: poolNameMap.get(p.poolId || "") || null,
    }));

    // 计算实时封禁状态
    const now = Math.floor(Date.now() / 1000);
    const result = data.map((p) => ({
      ...p,
      isBanned: p.status === "down" && p.cooldownEnd !== null && p.cooldownEnd > now,
    }));

    return res.status(200).json({
      success: true,
      data: result,
      total: result.length,
    });
  } catch (err) {
    console.error("[GET /api/admin/proxies] 获取代理列表失败:", err);
    return res.status(500).json({ success: false, error: "获取代理列表失败", detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * POST /api/admin/proxies — 创建代理
 *
 * 请求体：
 *   - address: string（必填）— 代理地址（http://user:pass@host:port 或 socks5://host:port）
 *   - poolId?: string — 关联代理池 ID（可选）
 *
 * 校验规则：
 *   - 地址不能为空，必须为合法 URL
 *   - 协议必须为 http、https 或 socks5
 *   - 不允许指向内网/保留地址
 *   - 如果提供了 poolId，对应的代理池必须存在
 */
async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const body: any = req.body;
    const { address, poolId } = body;

    const errors: string[] = [];

    // 校验代理地址
    if (!address || typeof address !== "string" || address.trim().length === 0) {
      errors.push("代理地址不能为空");
    } else {
      const addrError = validateProxyAddress(address.trim());
      if (addrError) {
        errors.push(addrError);
      }
    }

    // 校验代理池（可选）
    if (poolId && typeof poolId === "string") {
      const db = await createDb();
      const pool = await db.proxyPools.findFirst({
        where: { id: poolId },
        select: { id: true },
      });
      if (!pool) {
        errors.push("关联代理池不存在");
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join("; ") });
    }

    const db = await createDb();
    const now = Math.floor(Date.now() / 1000);
    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    // 写入数据库
    await db.proxies.create({
      data: {
        id,
        address: address.trim(),
        poolId: poolId && typeof poolId === "string" ? poolId : null,
        enabled: true,
        status: "healthy",
        failCount: 0,
        banCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    });

    // 审计日志（脱敏：不记录完整代理地址）
    try {
      await db.auditLogs.create({
        data: {
          id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          adminId: getAuditAdminId(admin),
          action: "create_proxy",
          detail: JSON.stringify({ target: id, address: "***", poolId: poolId || null }),
          ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
          createdAt: now,
        },
      });
    } catch (auditErr) {
      console.error("[POST /api/admin/proxies] 审计日志写入失败:", auditErr);
    }

    return res.status(200).json({
      success: true,
      data: {
        id,
        address: address.trim(),
        poolId: poolId || null,
        enabled: true,
        status: "healthy",
        failCount: 0,
        banCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      message: "代理创建成功",
    });
  } catch (err) {
    console.error("[POST /api/admin/proxies] 创建代理失败:", err);
    return res.status(500).json({ success: false, error: "创建代理失败", detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * 路由分发
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
    case "GET":
      return handleGet(req, res);
    case "POST":
      return handlePost(req, res);
    default:
      res.setHeader("Allow", ["GET", "POST"]);
      return res.status(405).json({ success: false, error: "方法不允许" });
  }
}
