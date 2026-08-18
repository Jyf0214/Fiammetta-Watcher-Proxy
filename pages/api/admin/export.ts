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
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";

/** 导出类型 */
type ExportType = "system" | "data" | "all";

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

    const rawExportType = (req.query.type as string) || "all";
    const VALID_EXPORT_TYPES = ["system", "data", "all"];
    if (!VALID_EXPORT_TYPES.includes(rawExportType)) {
      return res.status(400).json({ success: false, error: `无效的导出类型，允许: ${VALID_EXPORT_TYPES.join(", ")}` });
    }
    const exportType = rawExportType as ExportType;

    const db = await createDb();

    const now = Math.floor(Date.now() / 1000);

    // 导出数据基础结构
    const exportData: Record<string, unknown> = {
      version: "1.0.0",
      exportedAt: new Date(now * 1000).toISOString(),
      exportType,
    };

    // ==================== 系统级导出 ====================
    if (exportType === "system" || exportType === "all") {
      // 平台配置（保留密钥明文，用于跨环境迁移）
      const platforms = await db.platforms.findMany();

      exportData.platforms = platforms.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKeys: p.apiKeys,
        type: p.type,
        enabled: p.enabled,
        priority: p.priority,
        weight: p.weight,
        rpmLimit: p.rpmLimit,
        tpmLimit: p.tpmLimit,
        forwardHeaders: p.forwardHeaders,
        injectStreamOptions: p.injectStreamOptions,
        reuseUserAgent: p.reuseUserAgent,
        customUserAgent: p.customUserAgent,
        extraHeaders: p.extraHeaders,
        presetId: p.presetId,
        whitelisted: p.whitelisted,
        // 运行态字段（status/failCount/lastFailAt/cooldownEnd）不导出：
        // 导入时强制恢复为 healthy 初始态，导出包含它们会造成"导出什么、
        // 导入什么"的语义不一致
      }));

      // 模型映射（id 必须导出：导入时保留原始 id 才能恢复 platformId 关联）
      const modelMaps = await db.modelMappings.findMany();

      exportData.modelMaps = modelMaps.map((m) => ({
        id: m.id,
        alias: m.alias,
        targetModel: m.targetModel,
        platformId: m.platformId,
      }));

      // 平台模型（自动发现结果）：不导出则跨环境恢复后路由缓存无模型，
      // v1 请求全部「模型不存在」，直到下一轮 model-fetch 才重建
      const platformModels = await db.platformModels.findMany();

      exportData.platformModels = platformModels.map((pm) => ({
        id: pm.id,
        platformId: pm.platformId,
        modelId: pm.modelId,
        ownedBy: pm.ownedBy,
        modelName: pm.modelName,
        type: pm.type,
        source: pm.source,
        enabled: pm.enabled,
        fetchedAt: pm.fetchedAt,
      }));

      // 系统配置
      const configs = await db.configs.findMany();

      exportData.configs = configs
        .map((c) => ({
          key: c.key,
          value: c.value,
        }));
    }

    // ==================== 数据级导出 ====================
    if (exportType === "data" || exportType === "all") {
      // API Keys（保留明文，用于跨环境迁移）
      const apiKeysData = await db.apiKeys.findMany();

      exportData.apiKeys = apiKeysData.map((k) => ({
        id: k.id,
        key: k.key,
        name: k.name,
        usedTokens: k.usedTokens,
        rpmLimit: k.rpmLimit,
        tpmLimit: k.tpmLimit,
        callLimit: k.callLimit,
        callUsed: k.callUsed,
        tokenLimit: k.tokenLimit,
        resetPeriod: k.resetPeriod,
        status: k.status,
        expiresAt: k.expiresAt,
        createdAt: k.createdAt,
      }));

      // 请求日志（最近 30 天，最多 10000 条）：与导入上限（import.ts MAX_PER_TYPE.requestLogs）
      // 对齐，保证"导出 → 导入"闭环可行；超出部分截断并告警
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60;
      const requestLogsExport: Array<Record<string, unknown>> = [];
      {
        const batch = await db.requestLogs.findMany({
          where: { createdAt: { gte: thirtyDaysAgo } },
          orderBy: { createdAt: "desc" },
          take: 10000,
        });
        if (batch.length >= 10000) {
          console.warn("[GET /api/admin/export] 30 天内请求日志达到 10000 条上限，仅导出前 10000 条（与导入上限对齐）");
        }
        for (const r of batch) {
          requestLogsExport.push({
            id: r.id,
            keyId: r.keyId,
            keyName: r.keyName,
            platformId: r.platformId,
            model: r.model,
            endpoint: r.endpoint,
            method: r.method,
            status: r.status,
            latency: r.latency,
            tokens: r.tokens,
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            ttft: r.ttft,
            cost: r.cost,
            isError: r.isError,
            ipAddress: r.ipAddress,
            userAgent: r.userAgent,
            proxyUrl: r.proxyUrl,
            errorMessage: r.errorMessage,
            createdAt: r.createdAt,
          });
        }
      }
      exportData.requestLogs = requestLogsExport;

      // 每日统计（最近 1000 条）
      const dailyStatsData = await db.dailyStats.findMany({
        orderBy: { date: "desc" },
        take: 1000,
      });

      exportData.dailyStats = dailyStatsData;

      // 审计日志（最近 30 天，最多 5000 条）
      const auditLogsData = await db.auditLogs.findMany({
        orderBy: { createdAt: "desc" },
        take: 5000,
      });

      exportData.auditLogs = auditLogsData
        .filter((l) => l.createdAt >= thirtyDaysAgo)
        .map((l) => ({
          adminId: l.adminId,
          action: l.action,
          detail: l.detail,
          ip: l.ip,
          createdAt: l.createdAt,
        }));
    }

    // 审计日志：记录导出操作
    await db.auditLogs.create({
      data: {
        id: crypto.randomUUID(),
        adminId: getAuditAdminId(admin),
        action: "export_data",
        detail: JSON.stringify({ exportType }),
        ip:
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
        createdAt: now,
      },
    });

    // 返回 JSON 文件下载
    const filename = `fwp-export-${exportType}-${new Date(now * 1000).toISOString().slice(0, 10)}.json`;
    const jsonContent = JSON.stringify(exportData, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value, 2);

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
