/**
 * 数据导出/备份构建器
 *
 * 从 pages/api/admin/export.ts 抽出的共享模块：
 * - 手动导出（/api/admin/export）与定时备份 cron 共用同一套表读取与
 *   字段映射逻辑，保证「手动导出什么、自动备份什么」语义一致；
 * - 导出保留平台/Key 密钥明文（跨环境迁移用途），因此备份必须加密后
 *   才允许离开本机（见 src/lib/backup.ts 的强制加密门控）；
 * - 运行态字段（status/failCount/cooldownEnd 等）不导出：导入时强制恢复
 *   healthy 初始态，与既有导入语义一致。
 */

import type { Database } from "@/lib/prisma";

/** 导出类型 */
export type ExportType = "system" | "data" | "all";

type DbClient = Awaited<ReturnType<typeof import("@/lib/prisma").createDb>>;

/** BigInt 序列化 replacer（D1/TiDB 行含 BigInt 列时 JSON.stringify 必须携带） */
export const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

// ==================== 系统级数据 ====================

async function collectSystemSection(db: DbClient): Promise<Record<string, unknown>> {
  // 平台配置（保留密钥明文，用于跨环境迁移）
  const platforms = await db.platforms.findMany();

  const platformMaps = platforms.map((p) => ({
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
  }));

  // 模型映射（id 必须导出：导入时保留原始 id 才能恢复 platformId 关联）
  const modelMaps = await db.modelMappings.findMany();

  const modelMapRows = modelMaps.map((m) => ({
    id: m.id,
    alias: m.alias,
    targetModel: m.targetModel,
    platformId: m.platformId,
  }));

  // 平台模型（自动发现结果）：不导出则跨环境恢复后路由缓存无模型，
  // v1 请求全部「模型不存在」，直到下一轮 model-fetch 才重建
  const platformModels = await db.platformModels.findMany();

  const platformModelRows = platformModels.map((pm) => ({
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

  return {
    platforms: platformMaps,
    modelMaps: modelMapRows,
    platformModels: platformModelRows,
    configs: configs.map((c) => ({ key: c.key, value: c.value })),
  };
}

// ==================== 数据级数据 ====================

async function collectApiKeys(db: DbClient): Promise<unknown[]> {
  // API Keys（保留明文，用于跨环境迁移）
  const apiKeysData = await db.apiKeys.findMany();

  return apiKeysData.map((k) => ({
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
}

async function collectDataSection(db: DbClient): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);

  const apiKeys = await collectApiKeys(db);

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
      console.warn("[backup-builder] 30 天内请求日志达到 10000 条上限，仅导出前 10000 条（与导入上限对齐）");
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
        nodeName: r.nodeName,
        proxyUrl: r.proxyUrl,
        errorMessage: r.errorMessage,
        createdAt: r.createdAt,
      });
    }
  }

  // 每日统计（最近 1000 条）
  const dailyStatsData = await db.dailyStats.findMany({
    orderBy: { date: "desc" },
    take: 1000,
  });

  // 审计日志（最近 30 天，最多 5000 条）
  const auditLogsData = await db.auditLogs.findMany({
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  return {
    apiKeys,
    requestLogs: requestLogsExport,
    dailyStats: dailyStatsData,
    auditLogs: auditLogsData
      .filter((l) => l.createdAt >= thirtyDaysAgo)
      .map((l) => ({
        adminId: l.adminId,
        action: l.action,
        detail: l.detail,
        ip: l.ip,
        createdAt: l.createdAt,
      })),
  };
}

// ==================== 对外入口 ====================

/** 构建手动导出数据（与原 /api/admin/export 行为一致） */
export async function buildExportData(
  db: DbClient,
  exportType: ExportType
): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  const exportData: Record<string, unknown> = {
    version: "1.0.0",
    exportedAt: new Date(now * 1000).toISOString(),
    exportType,
  };

  if (exportType === "system" || exportType === "all") {
    Object.assign(exportData, await collectSystemSection(db));
  }
  if (exportType === "data" || exportType === "all") {
    Object.assign(exportData, await collectDataSection(db));
  }

  return exportData;
}

/**
 * 构建定时备份快照：系统级配置 + API Keys。
 *
 * 不含请求日志/统计/审计——它们体积大、可再生（统计可由日志重算），
 * 且备份 payload 需要经 webhook 外发，必须控制体积。
 * exportType 标记为 "config-backup"，与手动导出的 "all"/"system" 区分，
 * 导入端按既有 system/data 键名兼容处理。
 */
export async function buildConfigBackup(db: DbClient): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  const backup: Record<string, unknown> = {
    version: "1.0.0",
    exportedAt: new Date(now * 1000).toISOString(),
    exportType: "config-backup",
  };
  Object.assign(backup, await collectSystemSection(db));
  backup.apiKeys = await collectApiKeys(db);
  return backup;
}

/** 兼容旧签名引用（worker 定时器等无 NextRequest 场景的类型收窄用） */
export type BackupDb = DbClient | Database;
