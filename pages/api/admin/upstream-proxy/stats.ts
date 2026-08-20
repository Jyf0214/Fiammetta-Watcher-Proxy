/**
 * 出站代理实际可用性监控管理 API
 *
 * GET /api/admin/upstream-proxy/stats?hours=24 — 按代理聚合近 N 小时真实业务
 * 请求日志（请求数 / 200 数 / 429 等错误数 / 可用率），附带定期更新状态
 * （最近拉取时间 poolUpdatedAt、最近健康检查时间 lastHealthAt）
 *
 * 仅 Docker 部署可用（代理功能本身仅 Docker 生效）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import {
  getProxyHealth,
  getDegradedProxyUrls,
  proxyStatKey,
  getProxyDisableMode,
  UPSTREAM_PROXY_POOL_KEY,
} from "@/lib/upstream-proxy";

/** 单代理统计：按状态码分类的请求分布与可用率（可用率 = 2xx 请求占比） */
export interface ProxyTrafficStats {
  total: number;
  ok: number;
  err429: number;
  err401: number;
  err403: number;
  err5xx: number;
  other: number;
  availability: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  if (process.env.DEPLOY_PLATFORM !== "docker") {
    return res.status(400).json({ success: false, error: "出站代理仅 Docker 部署可用" });
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ success: false, error: "方法不允许" });
  }

  try {
    const db = await createDb();

    // 统计窗口：默认近 24h，可传 hours（1-168）；非法/0 落回缺省 24
    const rawHours = Array.isArray(req.query.hours) ? req.query.hours[0] : req.query.hours;
    const parsedHours = Number.parseInt(String(rawHours ?? "24"), 10);
    const hours = parsedHours >= 1 ? Math.min(parsedHours, 168) : 24;
    const since = Math.floor(Date.now() / 1000) - hours * 3600;

    const grouped = await db.requestLogs.groupBy({
      by: ["proxyUrl", "status"],
      where: {
        proxyUrl: { not: null },
        createdAt: { gte: since },
      },
      _count: { _all: true },
    });

    const stats: Record<string, ProxyTrafficStats> = {};
    for (const row of grouped) {
      if (!row.proxyUrl) continue;
      // 聚合键转为代理级统计键：带凭据账号按指纹（host:port#<hash>）独立成键，
      // 同 host:port 不同账号的请求数/可用率不再合并；历史无凭据/maskProxyUrl 键
      // 归入裸 host:port（历史数据无法归属具体账号），兼容旧日志
      const url = proxyStatKey(row.proxyUrl);
      const cur = stats[url] ?? {
        total: 0,
        ok: 0,
        err429: 0,
        err401: 0,
        err403: 0,
        err5xx: 0,
        other: 0,
        availability: 0,
      };
      const count = row._count._all;
      cur.total += count;
      if (row.status >= 200 && row.status < 300) cur.ok += count;
      else if (row.status === 429) cur.err429 += count;
      else if (row.status === 401) cur.err401 += count;
      else if (row.status === 403) cur.err403 += count;
      else if (row.status >= 500 && row.status < 600) cur.err5xx += count;
      else cur.other += count;
      stats[url] = cur;
    }
    for (const stat of Object.values(stats)) {
      stat.availability = stat.total > 0 ? stat.ok / stat.total : 0;
    }

    // 定期更新状态：最近拉取时间（pool 配置行 updatedAt）、最近健康检查时间
    // （健康表内全部代理 checkedAt 的最大值）
    let poolUpdatedAt: number | null = null;
    try {
      const poolRow = await db.configs.findUnique({ where: { key: UPSTREAM_PROXY_POOL_KEY } });
      poolUpdatedAt = poolRow?.updatedAt ?? null;
    } catch (err) {
      console.error("[API /api/admin/upstream-proxy/stats] 读取拉取时间失败:", err instanceof Error ? err.message : String(err));
    }
    let lastHealthAt: number | null = null;
    try {
      const { results } = await getProxyHealth(db);
      for (const entry of Object.values(results)) {
        if (entry.checkedAt > (lastHealthAt ?? 0)) lastHealthAt = entry.checkedAt;
      }
    } catch (err) {
      console.error("[API /api/admin/upstream-proxy/stats] 读取健康检查时间失败:", err instanceof Error ? err.message : String(err));
    }

    // 当前统计降权（路由已跳过）的代理：进程内实时状态（与 v1 路由同进程，
    // 直接读内存 Map；键为原始 URL，转代理级统计键与前端查表一致——带凭据
    // 账号按指纹独立成键，同 host:port 不同账号的降权状态互不误伤）
    const degradedUrls = getDegradedProxyUrls().map(proxyStatKey);

    return res.status(200).json({
      success: true,
      data: {
        hours,
        stats,
        degradedUrls,
        poolUpdatedAt,
        lastHealthAt,
        // 设备级禁用状态（环境变量 UPSTREAM_PROXY_DISABLED）：all=整体禁用、
        // health=仅定时健康检查禁用；null=正常。前端据此展示提示条与禁用手动按钮
        proxyDisabled: getProxyDisableMode(),
      },
    });
  } catch (err) {
    console.error(
      "[API /api/admin/upstream-proxy/stats] 统计失败:",
      err instanceof Error ? err.message : String(err)
    );
    return res.status(500).json({ success: false, error: "统计失败" });
  }
}
