/**
 * 代理批量导入 API
 *
 * POST /api/admin/proxies/import — 从文本批量导入代理
 *
 * 请求体：
 *   - text: string   — 每行一条，格式 IP:端口:账号:密码
 *   - poolId?: string — 归属代理池 ID（可选）
 *
 * 去重规则：address 相同则覆盖（更新 enabled=true、status=healthy）。
 * 单次上限：1000 条。
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

/** 批量导入数量上限 */
const MAX_IMPORT = 1000;

/**
 * POST /api/admin/proxies/import — 批量导入代理
 *
 * 解析规则：
 *   - 每行一条，格式：IP:端口:账号:密码
 *   - 忽略空行和 # 开头的注释行
 *   - 自动转换为 http://账号:密码@IP:端口 格式
 *
 * 校验规则：
 *   - IP 支持数字格式和域名格式
 *   - 端口范围 1-65535
 *   - 拒绝内网/保留地址
 *   - 如果提供了 poolId，对应的代理池必须存在
 */
async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const body: any = req.body;
    const { text, poolId } = body;

    // 输入校验
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ success: false, error: "导入内容不能为空" });
    }

    const db = await createDb();

    // 校验代理池（可选）
    if (poolId && typeof poolId === "string") {
      const [pool] = await db
        .select({ id: schema.proxyPools.id })
        .from(schema.proxyPools)
        .where(eq(schema.proxyPools.id, poolId))
        .limit(1);
      if (!pool) {
        return res.status(400).json({ success: false, error: "关联代理池不存在" });
      }
    }

    // 解析每行：IP:端口:账号:密码 → http://账号:密码@IP:端口
    const lines = text
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0 && !line.startsWith("#"));

    const parsed: { address: string; ip: string; port: string }[] = [];
    const parseErrors: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.split(":");
      if (parts.length !== 4) {
        parseErrors.push(`第 ${i + 1} 行格式错误（期望 IP:端口:账号:密码）: ${line}`);
        continue;
      }

      const [ip, port, user, pass] = parts;

      // 基础校验
      if (!ip || !port || !user || !pass) {
        parseErrors.push(`第 ${i + 1} 行包含空字段: ${line}`);
        continue;
      }

      // 支持 IP 和域名格式
      if (
        !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) &&
        !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(ip)
      ) {
        parseErrors.push(`第 ${i + 1} 行 IP/域名格式无效: ${ip}`);
        continue;
      }

      // 内网/保留地址检查
      if (isDangerousHostname(ip)) {
        parseErrors.push(`第 ${i + 1} 行地址指向内网/保留地址: ${ip}`);
        continue;
      }

      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        parseErrors.push(`第 ${i + 1} 行端口无效: ${port}`);
        continue;
      }

      const address = `http://${user}:${pass}@${ip}:${port}`;
      parsed.push({ address, ip, port });
    }

    if (parsed.length === 0) {
      return res.status(400).json({
        success: false,
        error: "没有可导入的代理",
        details: parseErrors,
      });
    }

    // 批量导入数量上限
    if (parsed.length > MAX_IMPORT) {
      return res.status(400).json({
        success: false,
        error: `单次最多导入 ${MAX_IMPORT} 个代理，当前有 ${parsed.length} 个，请分批导入`,
      });
    }

    // 查询已有代理（按 address 去重，全局范围）
    const existingProxies = await db
      .select({ id: schema.proxies.id, address: schema.proxies.address })
      .from(schema.proxies);
    const existingMap = new Map(existingProxies.map((p) => [p.address, p.id]));

    let created = 0;
    let updated = 0;
    const now = Math.floor(Date.now() / 1000);

    // 批量处理（D1 不支持真正的事务，逐条执行但保持原子性语义）
    for (const item of parsed) {
      const existingId = existingMap.get(item.address);
      if (existingId) {
        // 覆盖：重置状态为可用
        await db
          .update(schema.proxies)
          .set({
            enabled: true,
            status: "healthy",
            failCount: 0,
            banCount: 0,
            cooldownEnd: null,
            updatedAt: now,
          } as any)
          .where(eq(schema.proxies.id, existingId));
        updated++;
      } else {
        const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        await db.insert(schema.proxies).values({
          id,
          address: item.address,
          poolId: poolId && typeof poolId === "string" ? poolId : null,
          enabled: true,
          status: "healthy",
          failCount: 0,
          banCount: 0,
          createdAt: now,
          updatedAt: now,
        } as any);
        created++;
      }
    }

    // 审计日志
    try {
      await db.insert(schema.auditLogs).values({
        id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        adminId: admin.adminId,
        action: "import_proxies",
        detail: JSON.stringify({
          target: poolId || null,
          created,
          updated,
          parseErrors: parseErrors.length,
        }),
        ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
        createdAt: now,
      } as any);
    } catch (auditErr) {
      console.error("[POST /api/admin/proxies/import] 审计日志写入失败:", auditErr);
    }

    return res.status(200).json({
      success: true,
      message: `导入完成：新增 ${created} 个，覆盖 ${updated} 个`,
      data: { created, updated, total: parsed.length, parseErrors },
    });
  } catch (err) {
    console.error("[POST /api/admin/proxies/import] 批量导入失败:", err);
    return res.status(500).json({ success: false, error: "批量导入失败" });
  }
}

/**
 * 路由分发
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
    case "POST":
      return handlePost(req, res);
    default:
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ success: false, error: "方法不允许" });
  }
}
