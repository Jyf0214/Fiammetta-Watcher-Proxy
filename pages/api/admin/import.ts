/**
 * 数据导入 API
 *
 * POST /api/admin/import — 导入导出的 JSON 数据
 *
 * 请求体：export API 导出的 JSON 数据
 *
 * 导入规则：
 * - 验证 version 和 exportedAt 元数据
 * - 按 ID 或名称匹配，已存在则跳过
 * - 脱敏值（含 ***）自动跳过
 * - 导入不会删除现有数据，只添加新数据
 * - 敏感配置（admin_reset_password）跳过
 * - 有依赖关系的数据按顺序导入（proxy_pools → proxies）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { eq } from "drizzle-orm";
import { getAdminFromRequest } from "./_auth";

/** 每类导入的结果统计 */
interface ImportResult {
  imported: number;
  skipped: number;
}

/** 完整导入结果 */
interface FullImportResult {
  success: boolean;
  message: string;
  details: {
    platforms?: ImportResult;
    modelMaps?: ImportResult;
    proxyPools?: ImportResult;
    proxies?: ImportResult;
    plans?: ImportResult;
    apiKeys?: ImportResult;
    configs?: ImportResult;
    auditLogs?: ImportResult;
    systemEvents?: ImportResult;
    requestLogs?: ImportResult;
  };
}

/** 增大 body size limit（导出数据可能超过默认 4MB） */
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "50mb",
    },
  },
};

/** 生成唯一 ID */
function generateId(): string {
  return crypto.randomUUID();
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ success: false, error: "Method not allowed" });
    return;
  }

  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }

  try {
    const body = req.body as Record<string, unknown>;

    // 验证导入数据格式
    if (!body || typeof body !== "object") {
      res.status(400).json({ success: false, error: "无效的导入数据格式" });
      return;
    }

    if (!body.version || !body.exportedAt) {
      res.status(400).json({
        success: false,
        error: "缺少必要的导出元数据（version、exportedAt）",
      });
      return;
    }

    const db = await createDb();

    // 流式响应：边处理边推送进度
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    const writeEvent = (event: Record<string, unknown>) => {
      res.write(JSON.stringify(event) + "\n");
    };

    /** 发送进度事件 */
    const sendProgress = (
      step: string,
      stepTotal: number,
      imported: number,
      skipped: number,
      totalProcessed: number,
      totalRecords: number
    ) => {
      writeEvent({
        type: "progress",
        step,
        stepTotal,
        imported,
        skipped,
        totalProcessed,
        totalRecords,
      });
    };

    // 定义导入步骤（保持依赖顺序）
    const steps: Array<{
      key: string;
      data: unknown;
      fn: (db: ReturnType<typeof createDb>, data: Array<Record<string, unknown>>) => Promise<ImportResult>;
    }> = [
      { key: "proxyPools", data: body.proxyPools, fn: importProxyPools },
      { key: "platforms", data: body.platforms, fn: importPlatforms },
      { key: "modelMaps", data: body.modelMaps, fn: importModelMaps },
      { key: "proxies", data: body.proxies, fn: importProxies },
      { key: "plans", data: body.plans, fn: importPlans },
      { key: "configs", data: body.configs, fn: importConfigs },
      { key: "apiKeys", data: body.apiKeys, fn: importApiKeys },
      { key: "auditLogs", data: body.auditLogs, fn: importAuditLogs },
      { key: "systemEvents", data: body.systemEvents, fn: importSystemEvents },
      { key: "requestLogs", data: body.requestLogs, fn: importRequestLogs },
    ];

    // 计算总记录数
    const totalRecords = steps.reduce((sum, s) => {
      const arr = s.data;
      return sum + (Array.isArray(arr) ? arr.length : 0);
    }, 0);

    const result: FullImportResult = {
      success: true,
      message: "导入完成",
      details: {},
    };

    let totalProcessed = 0;

    for (const step of steps) {
      const arr = step.data;
      if (!Array.isArray(arr) || arr.length === 0) continue;

      const stepTotal = arr.length;

      try {
        const importResult = await step.fn(db, arr as Array<Record<string, unknown>>);
        result.details[step.key as keyof typeof result.details] = importResult;
        totalProcessed += stepTotal;

        sendProgress(step.key, stepTotal, importResult.imported, importResult.skipped, totalProcessed, totalRecords);
      } catch (err) {
        console.error(`[import] 导入 ${step.key} 失败:`, err);
        totalProcessed += stepTotal;

        sendProgress(step.key, stepTotal, 0, stepTotal, totalProcessed, totalRecords);
      }
    }

    // 审计日志（独立处理，失败不影响导入结果）
    try {
      const now = Math.floor(Date.now() / 1000);
      const ipHeader = req.headers["x-forwarded-for"] as string | undefined;
      const clientIp = ipHeader?.split(",")[0]?.trim() || null;
      await db.insert(schema.auditLogs).values({
        id: generateId(),
        adminId: admin.adminId,
        action: "import_data",
        detail: JSON.stringify({
          exportType: body.exportType,
          exportedAt: body.exportedAt,
          details: result.details,
        }),
        ip: clientIp,
        createdAt: now,
      });
    } catch (auditErr) {
      console.warn("[POST /api/admin/import] 审计日志写入失败（不影响导入）:", auditErr);
    }

    // 汇总导入结果
    const summary = Object.entries(result.details)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v!.imported} 导入, ${v!.skipped} 跳过`)
      .join(", ");

    result.message = summary ? `导入完成: ${summary}` : "没有需要导入的数据";

    // 发送最终结果
    writeEvent({ type: "complete", ...result });
    res.end();
  } catch (err) {
    console.error("[POST /api/admin/import] 导入数据失败:", err);
    // 尝试发送错误事件
    try {
      if (!res.headersSent) {
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      }
      res.write(JSON.stringify({ type: "error", error: "导入数据失败: " + (err instanceof Error ? err.message : String(err)) }) + "\n");
      res.end();
    } catch {
      // 如果流已关闭，忽略
    }
  }
}

// ==================== 导入各类型数据 ====================

/**
 * 导入平台配置
 *
 * 按名称去重，apiKey 含脱敏标记（***）时跳过
 */
async function importPlatforms(
  db: ReturnType<typeof createDb>,
  platforms: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  // 预加载已有平台名称，用于去重
  const existingNames = await db.select({ name: schema.platforms.name }).from(schema.platforms);
  const existingNameSet = new Set(existingNames.map((r) => r.name));

  // 过滤无效和重复记录
  const validPlatforms = platforms.filter((p) => {
    const name = p.name as string;
    const apiKey = p.apiKey as string;
    if (!name || !apiKey || apiKey.includes("***")) return false;
    if (existingNameSet.has(name)) return false;
    return true;
  });

  skipped += platforms.length - validPlatforms.length;

  if (validPlatforms.length === 0) {
    return { imported, skipped };
  }

  // 批量插入
  const now = Math.floor(Date.now() / 1000);
  const stmts = validPlatforms.map((p) =>
    db.insert(schema.platforms).values({
      id: generateId(),
      name: p.name as string,
      baseUrl: p.baseUrl as string,
      apiKey: p.apiKey as string,
      apiKeys: (p.apiKeys as string) || "[]",
      type: (p.type as string) || "openai",
      enabled: p.enabled !== false,
      priority: (p.priority as number) ?? 0,
      weight: (p.weight as number) ?? 1,
      rpmLimit: (p.rpmLimit as number) ?? null,
      tpmLimit: (p.tpmLimit as number) ?? null,
      forwardHeaders: (p.forwardHeaders as string) || "[]",
      status: "healthy",
      failCount: 0,
      createdAt: now,
      updatedAt: now,
    } as any)
  );

  try {
    await db.batch(stmts);
    imported += validPlatforms.length;
  } catch (err) {
    console.error("[import] 批量导入平台失败:", err);
    skipped += validPlatforms.length;
  }

  return { imported, skipped };
}

/**
 * 导入模型映射
 *
 * 按 alias 去重，使用 db.batch() 批量执行
 */
async function importModelMaps(
  db: ReturnType<typeof createDb>,
  modelMaps: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  // 预加载已有 alias，用于去重
  const existingAliases = await db.select({ alias: schema.modelMappings.alias }).from(schema.modelMappings);
  const existingAliasSet = new Set(existingAliases.map((r) => r.alias));

  const validMaps = modelMaps.filter((m) => {
    const alias = m.alias as string;
    if (!alias) return false;
    if (existingAliasSet.has(alias)) return false;
    return true;
  });

  skipped += modelMaps.length - validMaps.length;

  if (validMaps.length === 0) {
    return { imported, skipped };
  }

  const now = Math.floor(Date.now() / 1000);
  const stmts = validMaps.map((m) =>
    db.insert(schema.modelMappings).values({
      id: generateId(),
      alias: m.alias as string,
      targetModel: (m.targetModel as string) || null,
      platformId: (m.platformId as string) || null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    } as any)
  );

  try {
    await db.batch(stmts);
    imported += validMaps.length;
  } catch (err) {
    console.error("[import] 批量导入模型映射失败:", err);
    skipped += validMaps.length;
  }

  return { imported, skipped };
}

/**
 * 导入代理池
 *
 * 按名称去重，使用 db.batch() 批量执行
 */
async function importProxyPools(
  db: ReturnType<typeof createDb>,
  pools: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  // 预加载已有名称，用于去重
  const existingNames = await db.select({ name: schema.proxyPools.name }).from(schema.proxyPools);
  const existingNameSet = new Set(existingNames.map((r) => r.name));

  const validPools = pools.filter((p) => {
    const name = p.name as string;
    if (!name) return false;
    if (existingNameSet.has(name)) return false;
    return true;
  });

  skipped += pools.length - validPools.length;

  if (validPools.length === 0) {
    return { imported, skipped };
  }

  const now = Math.floor(Date.now() / 1000);
  const stmts = validPools.map((p) =>
    db.insert(schema.proxyPools).values({
      id: generateId(),
      name: p.name as string,
      enabled: p.enabled !== false,
      createdAt: now,
      updatedAt: now,
    } as any)
  );

  try {
    await db.batch(stmts);
    imported += validPools.length;
  } catch (err) {
    console.error("[import] 批量导入代理池失败:", err);
    skipped += validPools.length;
  }

  return { imported, skipped };
}

/**
 * 导入代理
 *
 * 按地址去重，使用 db.batch() 批量执行
 */
async function importProxies(
  db: ReturnType<typeof createDb>,
  proxies: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  // 预加载已有地址，用于去重
  const existingAddrs = await db.select({ address: schema.proxies.address }).from(schema.proxies);
  const existingAddrSet = new Set(existingAddrs.map((r) => r.address));

  const validProxies = proxies.filter((p) => {
    const address = p.address as string;
    if (!address || address.includes("***")) return false;
    if (existingAddrSet.has(address)) return false;
    return true;
  });

  skipped += proxies.length - validProxies.length;

  if (validProxies.length === 0) {
    return { imported, skipped };
  }

  const now = Math.floor(Date.now() / 1000);
  const stmts = validProxies.map((p) =>
    db.insert(schema.proxies).values({
      id: generateId(),
      address: p.address as string,
      poolId: (p.poolId as string) || null,
      enabled: p.enabled !== false,
      status: "healthy",
      failCount: 0,
      banCount: 0,
      createdAt: now,
      updatedAt: now,
    } as any)
  );

  try {
    await db.batch(stmts);
    imported += validProxies.length;
  } catch (err) {
    console.error("[import] 批量导入代理失败:", err);
    skipped += validProxies.length;
  }

  return { imported, skipped };
}

/**
 * 导入套餐模板
 *
 * 按名称去重，使用 db.batch() 批量执行
 */
async function importPlans(
  db: ReturnType<typeof createDb>,
  plans: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  // 预加载已有名称，用于去重
  const existingNames = await db.select({ name: schema.plans.name }).from(schema.plans);
  const existingNameSet = new Set(existingNames.map((r) => r.name));

  const validPlans = plans.filter((p) => {
    const name = p.name as string;
    if (!name) return false;
    if (existingNameSet.has(name)) return false;
    return true;
  });

  skipped += plans.length - validPlans.length;

  if (validPlans.length === 0) {
    return { imported, skipped };
  }

  const now = Math.floor(Date.now() / 1000);
  const stmts = validPlans.map((p) =>
    db.insert(schema.plans).values({
      id: generateId(),
      name: p.name as string,
      tokenQuota: (p.tokenQuota as number) ?? 0,
      callLimit: (p.callLimit as number) ?? null,
      rpmLimit: (p.rpmLimit as number) ?? null,
      tpmLimit: (p.tpmLimit as number) ?? null,
      resetPeriod: (p.resetPeriod as string) || "monthly",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    } as any)
  );

  try {
    await db.batch(stmts);
    imported += validPlans.length;
  } catch (err) {
    console.error("[import] 批量导入套餐失败:", err);
    skipped += validPlans.length;
  }

  return { imported, skipped };
}

/**
 * 导入 API Keys
 *
 * 按 key 值去重，使用 db.batch() 批量执行
 */
async function importApiKeys(
  db: ReturnType<typeof createDb>,
  apiKeysData: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  // 预加载已有 key 集合，用于去重
  const existingKeys = await db.select({ key: schema.apiKeys.key }).from(schema.apiKeys);
  const existingKeySet = new Set(existingKeys.map((r) => r.key));

  // 过滤无效和重复记录
  const validKeys = apiKeysData.filter((k) => {
    const key = k.key as string;
    if (!key || key.includes("***")) return false;
    if (existingKeySet.has(key)) return false;
    return true;
  });

  skipped += apiKeysData.length - validKeys.length;

  if (validKeys.length === 0) {
    return { imported, skipped };
  }

  // 批量插入
  const now = Math.floor(Date.now() / 1000);
  const batchSize = 50;
  for (let i = 0; i < validKeys.length; i += batchSize) {
    const batch = validKeys.slice(i, i + batchSize);
    const stmts = batch.map((k) =>
      db.insert(schema.apiKeys).values({
        id: generateId(),
        key: k.key as string,
        name: (k.name as string) || "导入的 Key",
        planId: (k.planId as string) || null,
        quota: k.quota ? Number(k.quota) : null,
        usedTokens: Number(k.usedTokens) || 0,
        rpmLimit: (k.rpmLimit as number) ?? null,
        tpmLimit: (k.tpmLimit as number) ?? null,
        callLimit: (k.callLimit as number) ?? null,
        callUsed: 0,
        tokenLimit: (k.tokenLimit as number) ?? null,
        resetPeriod: (k.resetPeriod as string) || "monthly",
        status: (k.status as string) || "active",
        expiresAt: k.expiresAt
          ? Math.floor(new Date(k.expiresAt as string).getTime() / 1000)
          : null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      } as any)
    );

    try {
      await db.batch(stmts);
      imported += batch.length;
    } catch (err) {
      console.error("[import] 批量导入 API Key 失败:", err);
      skipped += batch.length;
    }
  }

  return { imported, skipped };
}

/**
 * 导入系统配置
 *
 * 按 key 做 upsert（已存在则更新 value，不存在则创建）
 * 跳过敏感配置（admin_reset_password），使用 db.batch() 批量执行
 */
async function importConfigs(
  db: ReturnType<typeof createDb>,
  configs: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  // 预加载已有配置
  const existingConfigs = await db.select({ key: schema.configs.key }).from(schema.configs);
  const existingKeySet = new Set(existingConfigs.map((r) => r.key));

  // 分离插入和更新
  const toInsert: Array<Record<string, unknown>> = [];
  const toUpdate: Array<Record<string, unknown>> = [];

  for (const c of configs) {
    const key = c.key as string;
    const value = c.value as string;

    if (!key || !value) {
      skipped++;
      continue;
    }

    if (key === "admin_reset_password") {
      skipped++;
      continue;
    }

    const now = Math.floor(Date.now() / 1000);
    if (existingKeySet.has(key)) {
      toUpdate.push({ key, value, updatedAt: now });
    } else {
      toInsert.push({ key, value, updatedAt: now });
    }
  }

  // 批量插入新配置
  if (toInsert.length > 0) {
    const stmts = toInsert.map((c) =>
      db.insert(schema.configs).values({
        key: c.key as string,
        value: c.value as string,
        updatedAt: c.updatedAt as number,
      } as any)
    );
    try {
      await db.batch(stmts);
      imported += toInsert.length;
    } catch (err) {
      console.error("[import] 批量插入配置失败:", err);
      skipped += toInsert.length;
    }
  }

  // 批量更新已有配置
  if (toUpdate.length > 0) {
    const stmts = toUpdate.map((c) =>
      db.update(schema.configs)
        .set({ value: c.value as string, updatedAt: c.updatedAt as number } as any)
        .where(eq(schema.configs.key, c.key as string))
    );
    try {
      await db.batch(stmts);
      imported += toUpdate.length;
    } catch (err) {
      console.error("[import] 批量更新配置失败:", err);
      skipped += toUpdate.length;
    }
  }

  return { imported, skipped };
}

// ==================== 导入审计日志 ====================

/**
 * 将 ISO 时间字符串或 unix 时间戳转换为 unix 秒
 */
function toUnixSeconds(value: unknown): number {
  if (typeof value === "number" && value > 1_000_000_000) {
    return value;
  }
  if (typeof value === "string") {
    const ts = Math.floor(new Date(value).getTime() / 1000);
    if (!isNaN(ts) && ts > 0) return ts;
  }
  return Math.floor(Date.now() / 1000);
}

/**
 * 导入审计日志
 *
 * 无外键依赖，使用 db.batch() 批量执行
 * adminId 不存在时置为 null（不阻塞导入）
 */
async function importAuditLogs(
  db: ReturnType<typeof createDb>,
  logs: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  // 预加载已有 adminId 集合，用于外键校验
  const existingAdminRows = await db.select({ id: schema.admins.id }).from(schema.admins);
  const validAdminIds = new Set(existingAdminRows.map((r) => r.id));

  const validLogs = logs.filter((log) => log.action);

  const batchSize = 50;
  for (let i = 0; i < validLogs.length; i += batchSize) {
    const batch = validLogs.slice(i, i + batchSize);
    const stmts = batch.map((log) => {
      const rawAdminId = log.adminId as string | null | undefined;
      return db.insert(schema.auditLogs).values({
        id: generateId(),
        adminId: rawAdminId && validAdminIds.has(rawAdminId) ? rawAdminId : null,
        action: log.action as string,
        detail: (log.detail as string) || null,
        ip: (log.ip as string) || null,
        createdAt: toUnixSeconds(log.createdAt),
      } as any);
    });

    try {
      await db.batch(stmts);
      imported += batch.length;
    } catch (err) {
      console.error("[import] 批量导入审计日志失败:", err);
      skipped += batch.length;
    }
  }

  skipped += logs.length - validLogs.length;
  return { imported, skipped };
}

// ==================== 导入系统事件 ====================

/**
 * 导入系统事件
 *
 * 无外键依赖，使用 db.batch() 批量执行
 */
async function importSystemEvents(
  db: ReturnType<typeof createDb>,
  events: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  const validEvents = events.filter((e) => e.message);

  const batchSize = 50;
  for (let i = 0; i < validEvents.length; i += batchSize) {
    const batch = validEvents.slice(i, i + batchSize);
    const stmts = batch.map((e) =>
      db.insert(schema.systemEvents).values({
        id: generateId(),
        level: (e.level as string) || "info",
        message: e.message as string,
        detail: (e.detail as string) || null,
        createdAt: toUnixSeconds(e.createdAt),
      } as any)
    );

    try {
      await db.batch(stmts);
      imported += batch.length;
    } catch (err) {
      console.error("[import] 批量导入系统事件失败:", err);
      skipped += batch.length;
    }
  }

  skipped += events.length - validEvents.length;
  return { imported, skipped };
}

// ==================== 导入请求日志 ====================

/**
 * 导入请求日志
 *
 * 无外键依赖，Promise.all 并发插入（每批50条并行）
 * 导出数据中 duration 字段映射为 latency
 */
async function importRequestLogs(
  db: ReturnType<typeof createDb>,
  logs: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  // 过滤无效记录
  const validLogs = logs.filter((log) => log.model);
  skipped += logs.length - validLogs.length;

  // 每 50 条一批，并发插入
  const batchSize = 50;
  for (let i = 0; i < validLogs.length; i += batchSize) {
    const batch = validLogs.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((log) =>
        db.insert(schema.requestLogs).values({
          id: generateId(),
          keyId: (log.keyId as string) || null,
          keyName: (log.keyName as string) || null,
          platformId: (log.platformId as string) || null,
          proxyId: (log.proxyId as string) || null,
          model: log.model as string,
          endpoint: (log.endpoint as string) || null,
          method: (log.method as string) || null,
          status: (log.status as number) || 0,
          latency: (log.duration as number) || (log.latency as number) || 0,
          tokens: (log.tokens as number) || 0,
          promptTokens: (log.promptTokens as number) || 0,
          completionTokens: (log.completionTokens as number) || 0,
          ttft: (log.ttft as number) || 0,
          cost: (log.cost as number) || 0,
          isError: Boolean(log.isError),
          ipAddress: (log.ipAddress as string) || null,
          userAgent: (log.userAgent as string) || null,
          errorMessage: (log.errorMessage as string) || null,
          createdAt: toUnixSeconds(log.createdAt),
        } as any)
      )
    );

    for (const r of results) {
      if (r.status === "fulfilled") imported++;
      else {
        skipped++;
        console.error("[import] 请求日志插入失败:", r.reason);
      }
    }
  }

  return { imported, skipped };
}
