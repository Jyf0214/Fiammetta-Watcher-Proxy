/**
 * 数据导出 API
 *
 * GET /api/admin/export — 导出系统数据
 *
 * 查询参数：
 * - type: 导出类型（system/data/all），默认 all
 *   - system: 平台、模型映射、配置
 *   - data: API Keys、请求日志、每日统计、审计日志
 *   - all: 以上全部
 *
 * 返回 JSON 文件下载，Content-Type: application/json
 *
 * 表读取与字段映射逻辑已抽至 src/lib/backup-builder.ts（与定时备份 cron
 * 共用同一套构建逻辑），本文件只负责鉴权、限流、审计与下载响应。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { getClientIp } from "./auth";
import { buildExportData, bigintReplacer, type ExportType } from "@/lib/backup-builder";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    res.status(405).json({ success: false, error: "Method not allowed" });
    return;
  }

  try {
    const admin = await getAdminFromRequest(req);
    if (!admin) {
      res.status(401).json({ success: false, error: "未授权" });
      return;
    }
    // 与 stats/audit/logs 等读端点对齐：全量导出是最重的查询（多表 + 近30天日志），
    // 凭据泄露时若无速率约束可反复拉取整库明文并构成 DB 全表扫描 DoS
    if (!(await checkAdminRateLimit(admin.adminId, res))) return;

    const rawExportType = (req.query.type as string) || "all";
    const VALID_EXPORT_TYPES = ["system", "data", "all"];
    if (!VALID_EXPORT_TYPES.includes(rawExportType)) {
      return res.status(400).json({ success: false, error: `无效的导出类型，允许: ${VALID_EXPORT_TYPES.join(", ")}` });
    }
    const exportType = rawExportType as ExportType;

    const db = await createDb();

    const exportData = await buildExportData(db, exportType);

    // 审计日志：记录导出操作
    const now = Math.floor(Date.now() / 1000);
    await db.auditLogs.create({
      data: {
        id: crypto.randomUUID(),
        adminId: getAuditAdminId(admin),
        action: "export_data",
        detail: JSON.stringify({ exportType }),
        ip: getClientIp(req),
        createdAt: now,
      },
    });

    // 返回 JSON 文件下载
    const filename = `fwp-export-${exportType}-${new Date(now * 1000).toISOString().slice(0, 10)}.json`;
    const jsonContent = JSON.stringify(exportData, bigintReplacer, 2);

    // 导出含明文密钥，禁止浏览器/CDN 缓存
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).send(jsonContent);
  } catch (err) {
    console.error("[GET /api/admin/export] 导出数据失败:", err instanceof Error ? err.message : String(err));
    res.status(500).json({ success: false, error: "导出数据失败" });
  }
}
