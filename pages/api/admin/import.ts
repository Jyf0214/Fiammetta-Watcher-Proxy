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

    const db = createDb((globalThis as Record<string, unknown>).DB as D1Database);
    const result: FullImportResult = {
      success: true,
      message: "导入完成",
      details: {},
    };

    // 按顺序导入各类数据（有依赖关系：proxy_pools 需要先于 proxies）
    if (body.proxyPools && Array.isArray(body.proxyPools)) {
      result.details.proxyPools = await importProxyPools(db, body.proxyPools as Array<Record<string, unknown>>);
    }

    if (body.platforms && Array.isArray(body.platforms)) {
      result.details.platforms = await importPlatforms(db, body.platforms as Array<Record<string, unknown>>);
    }

    if (body.modelMaps && Array.isArray(body.modelMaps)) {
      result.details.modelMaps = await importModelMaps(db, body.modelMaps as Array<Record<string, unknown>>);
    }

    if (body.proxies && Array.isArray(body.proxies)) {
      result.details.proxies = await importProxies(db, body.proxies as Array<Record<string, unknown>>);
    }

    if (body.plans && Array.isArray(body.plans)) {
      result.details.plans = await importPlans(db, body.plans as Array<Record<string, unknown>>);
    }

    if (body.apiKeys && Array.isArray(body.apiKeys)) {
      result.details.apiKeys = await importApiKeys(db, body.apiKeys as Array<Record<string, unknown>>);
    }

    if (body.configs && Array.isArray(body.configs)) {
      result.details.configs = await importConfigs(db, body.configs as Array<Record<string, unknown>>);
    }

    // 审计日志
    const now = Math.floor(Date.now() / 1000);
    await db.insert(schema.auditLogs).values({
      id: generateId(),
      adminId: "import",
      action: "import_data",
      detail: JSON.stringify({
        exportType: body.exportType,
        exportedAt: body.exportedAt,
        details: result.details,
      }),
      ip:
        (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
      createdAt: now,
    } as any);

    // 汇总导入结果
    const summary = Object.entries(result.details)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v!.imported} 导入, ${v!.skipped} 跳过`)
      .join(", ");

    result.message = summary ? `导入完成: ${summary}` : "没有需要导入的数据";

    res.status(200).json(result);
  } catch (err) {
    console.error("[POST /api/admin/import] 导入数据失败:", err);
    res.status(500).json({
      success: false,
      error: "导入数据失败: " + (err instanceof Error ? err.message : String(err)),
    });
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

  for (const p of platforms) {
    try {
      // 按名称检查是否已存在
      const existing = await db
        .select()
        .from(schema.platforms)
        .where(eq(schema.platforms.name, p.name as string))
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      // 检查 apiKey 是否为脱敏值
      const apiKey = p.apiKey as string;
      if (!apiKey || apiKey.includes("***")) {
        skipped++;
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      await db.insert(schema.platforms).values({
        id: generateId(),
        name: p.name as string,
        baseUrl: p.baseUrl as string,
        apiKey,
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
      } as any);

      imported++;
    } catch (err) {
      console.error("[import] 导入平台失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 导入模型映射
 *
 * 按 alias + platformId 去重
 */
async function importModelMaps(
  db: ReturnType<typeof createDb>,
  modelMaps: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  for (const m of modelMaps) {
    try {
      const alias = m.alias as string;
      const targetModel = m.targetModel as string;
      const platformId = (m.platformId as string) || null;

      // 检查是否已存在
      const existing = await db
        .select()
        .from(schema.modelMappings)
        .where(eq(schema.modelMappings.alias, alias))
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      await db.insert(schema.modelMappings).values({
        id: generateId(),
        alias,
        targetModel,
        platformId,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      } as any);

      imported++;
    } catch (err) {
      console.error("[import] 导入模型映射失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 导入代理池
 *
 * 按名称去重
 */
async function importProxyPools(
  db: ReturnType<typeof createDb>,
  pools: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  for (const p of pools) {
    try {
      // 按名称检查是否已存在
      const existing = await db
        .select()
        .from(schema.proxyPools)
        .where(eq(schema.proxyPools.name, p.name as string))
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      await db.insert(schema.proxyPools).values({
        id: generateId(),
        name: p.name as string,
        enabled: p.enabled !== false,
        createdAt: now,
        updatedAt: now,
      } as any);

      imported++;
    } catch (err) {
      console.error("[import] 导入代理池失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 导入代理
 *
 * 按地址去重，address 含脱敏标记（***）时跳过
 */
async function importProxies(
  db: ReturnType<typeof createDb>,
  proxies: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  for (const p of proxies) {
    try {
      const address = p.address as string;
      if (!address || address.includes("***")) {
        skipped++;
        continue;
      }

      // 按地址检查是否已存在
      const existing = await db
        .select()
        .from(schema.proxies)
        .where(eq(schema.proxies.address, address))
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      await db.insert(schema.proxies).values({
        id: generateId(),
        address,
        poolId: (p.poolId as string) || null,
        enabled: p.enabled !== false,
        status: "healthy",
        failCount: 0,
        banCount: 0,
        createdAt: now,
        updatedAt: now,
      } as any);

      imported++;
    } catch (err) {
      console.error("[import] 导入代理失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 导入套餐模板
 *
 * 按名称去重
 */
async function importPlans(
  db: ReturnType<typeof createDb>,
  plans: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  for (const p of plans) {
    try {
      // 按名称检查是否已存在
      const existing = await db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.name, p.name as string))
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      await db.insert(schema.plans).values({
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
      } as any);

      imported++;
    } catch (err) {
      console.error("[import] 导入套餐失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 导入 API Keys
 *
 * 按 key 值去重，key 含脱敏标记（***）时跳过
 */
async function importApiKeys(
  db: ReturnType<typeof createDb>,
  apiKeysData: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  for (const k of apiKeysData) {
    try {
      // 检查 key 是否为脱敏值
      const key = k.key as string;
      if (!key || key.includes("***")) {
        skipped++;
        continue;
      }

      // 按 key 值检查是否已存在
      const existing = await db
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.key, key))
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      await db.insert(schema.apiKeys).values({
        id: generateId(),
        key,
        name: (k.name as string) || "导入的 Key",
        planId: (k.planId as string) || null,
        quota: k.quota ? Number(k.quota) : null,
        usedTokens: (k.usedTokens as number) || 0,
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
      } as any);

      imported++;
    } catch (err) {
      console.error("[import] 导入 API Key 失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 导入系统配置
 *
 * 按 key 做 upsert（已存在则更新 value，不存在则创建）
 * 跳过敏感配置（admin_reset_password）
 */
async function importConfigs(
  db: ReturnType<typeof createDb>,
  configs: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;

  for (const c of configs) {
    try {
      const key = c.key as string;
      const value = c.value as string;

      if (!key || !value) {
        skipped++;
        continue;
      }

      // 跳过敏感配置
      if (key === "admin_reset_password") {
        skipped++;
        continue;
      }

      // upsert：已存在则更新，不存在则创建
      const now = Math.floor(Date.now() / 1000);
      const existing = await db
        .select()
        .from(schema.configs)
        .where(eq(schema.configs.key, key))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(schema.configs)
          .set({ value, updatedAt: now } as any)
          .where(eq(schema.configs.key, key));
      } else {
        await db.insert(schema.configs).values({
          key,
          value,
          updatedAt: now,
        } as any);
      }

      imported++;
    } catch (err) {
      console.error("[import] 导入配置失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}
