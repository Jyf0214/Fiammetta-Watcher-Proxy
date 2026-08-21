/**
 * GET /api/admin/upstream-proxy/urls — 获取所有可用代理 URL 列表（供密钥级代理绑定选择器使用）
 *
 * 返回按组分组的代理 URL 列表（含组名与启用状态），供前端 Select 组件渲染选项。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { UPSTREAM_PROXY_CONFIG_KEY, UPSTREAM_PROXY_POOL_KEY } from "@/lib/upstream-proxy";

interface ProxyUrlItem {
  url: string;
  group: string;
  enabled: boolean;
  /** 来源：manual=手动添加，pulled=定时拉取 */
  source: "manual" | "pulled";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ success: false, error: "方法不允许" });
  }

  const admin = await getAdminFromRequest(req);
  if (!admin) return res.status(401).json({ success: false, error: "未授权" });
  if (!checkCsrfOrigin(req, res)) return;

  try {
    const db = await createDb();
    const [configRow, poolRow] = await Promise.all([
      db.configs.findFirst({ where: { key: UPSTREAM_PROXY_CONFIG_KEY }, select: { value: true } }),
      db.configs.findFirst({ where: { key: UPSTREAM_PROXY_POOL_KEY }, select: { value: true } }),
    ]);

    let groups: Array<{ name: string; urls: string[]; enabled: boolean }> = [];
    let pool: Record<string, string[]> = {};

    try {
      if (configRow?.value) {
        const cfg = JSON.parse(configRow.value);
        if (Array.isArray(cfg.groups)) {
          groups = cfg.groups.map((g: Record<string, unknown>) => ({
            name: typeof g.name === "string" ? g.name : "",
            urls: Array.isArray(g.urls) ? g.urls.filter((u: unknown) => typeof u === "string") : [],
            enabled: g.enabled !== false,
          }));
        }
      }
    } catch { /* ignore */ }

    try {
      if (poolRow?.value) {
        pool = JSON.parse(poolRow.value);
        if (typeof pool !== "object" || Array.isArray(pool)) pool = {};
      }
    } catch { /* ignore */ }

    const items: ProxyUrlItem[] = [];
    const seen = new Set<string>();
    for (const g of groups) {
      // 手动代理
      for (const url of g.urls) {
        if (!seen.has(url)) {
          seen.add(url);
          items.push({ url, group: g.name, enabled: g.enabled, source: "manual" });
        }
      }
      // 拉取代理
      for (const url of pool[g.name] ?? []) {
        if (!seen.has(url)) {
          seen.add(url);
          items.push({ url, group: g.name, enabled: g.enabled, source: "pulled" });
        }
      }
    }

    return res.status(200).json({ success: true, data: items });
  } catch (err) {
    console.error("[GET /api/admin/upstream-proxy/urls] 失败:", err);
    return res.status(500).json({ success: false, error: "获取代理列表失败" });
  }
}
