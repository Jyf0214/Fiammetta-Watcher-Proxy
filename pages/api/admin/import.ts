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
 * - 有依赖关系的数据按顺序导入
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { isSafeUrl, checkCsrfOrigin } from "@/lib/admin-security";

/** 每类导入的结果统计 */
interface ImportResult {
  imported: number;
  skipped: number;
  skipReasons?: Record<string, number>; // { "名称重复": 3, "API Key 已脱敏": 2 }
  error?: string;
}

/** 完整导入结果 */
interface FullImportResult {
  success: boolean;
  message: string;
  details: {
    platforms?: ImportResult;
    modelMaps?: ImportResult;
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
  // 导入是状态变更操作，必须校验来源（与其他 admin 写端点一致）
  if (!checkCsrfOrigin(req, res)) return;
  if (!await checkAdminRateLimit(admin.adminId, res)) return;

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

    // 数据量上限检查：避免超大导入导致 Cloudflare Workers 超时（CF1102）
    const requestLogCount = Array.isArray(body.requestLogs) ? body.requestLogs.length : 0;
    if (requestLogCount > 10000) {
      res.status(400).json({
        success: false,
        error: `请求日志数量 (${requestLogCount}) 超过上限 (10000)，请分批导入`,
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
      totalRecords: number,
      error?: string,
      skipReasons?: Record<string, number>
    ) => {
      const event: Record<string, unknown> = {
        type: "progress",
        step,
        stepTotal,
        imported,
        skipped,
        totalProcessed,
        totalRecords,
      };
      if (error) event.error = error;
      if (skipReasons && Object.keys(skipReasons).length > 0) event.skipReasons = skipReasons;
      writeEvent(event);
    };

    // 定义导入步骤（保持依赖顺序）
    type DbClient = Awaited<ReturnType<typeof createDb>>;
    const steps: Array<{
      key: string;
      data: unknown;
      fn: (db: DbClient, data: Array<Record<string, unknown>>) => Promise<ImportResult>;
    }> = [
      { key: "platforms", data: body.platforms, fn: importPlatforms },
      { key: "modelMaps", data: body.modelMaps, fn: importModelMaps },
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

        sendProgress(step.key, stepTotal, importResult.imported, importResult.skipped, totalProcessed, totalRecords, importResult.error, importResult.skipReasons);
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
      await db.auditLogs.create({
        data: {
          id: generateId(),
          adminId: getAuditAdminId(admin),
          action: "import_data",
          detail: JSON.stringify({
            exportType: body.exportType,
            exportedAt: body.exportedAt,
            details: result.details,
          }),
          ip: clientIp,
          createdAt: now,
        },
      });
    } catch (auditErr) {
      console.warn("[POST /api/admin/import] 审计日志写入失败（不影响导入）:", auditErr);
    }

    // 汇总导入结果（含跳过原因）
    const summary = Object.entries(result.details)
      .filter(([, v]) => v)
      .map(([k, v]) => {
        let text = `${k}: ${v!.imported} 导入, ${v!.skipped} 跳过`;
        if (v!.skipReasons && Object.keys(v!.skipReasons).length > 0) {
          const reasons = Object.entries(v!.skipReasons)
            .map(([reason, count]) => `${reason}×${count}`)
            .join(", ");
          text += `(${reasons})`;
        }
        return text;
      })
      .join("\n");

    result.message = summary ? `导入完成:\n${summary}` : "没有需要导入的数据";

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
      res.write(JSON.stringify({ type: "error", error: "导入数据失败" }) + "\n");
      res.end();
    } catch {
      // 如果流已关闭，忽略
    }
  }
}

// ==================== 导入各类型数据 ====================

type DbClient = Awaited<ReturnType<typeof createDb>>;

/** TiDB/MySQL VARCHAR(191) 最大长度（Prisma 对 MySQL String 默认生成 VARCHAR(191)） */
const VARCHAR_MAX = 191;

/** createMany 单批只发 1 个 HTTP 请求，设大减少 HTTP 往返 */
const BATCH_SIZE = 200;

/** 截断字符串到 TiDB VARCHAR(191) 限制，避免 Data too long 错误 */
function truncateStr(val: unknown, maxLen = VARCHAR_MAX): string {
  const s = String(val ?? "");
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/**
 * 规范化平台密钥为命名对象数组 JSON（兼容对象/字符串数组格式）
 *
 * 兼容旧导出格式：apiKey 主字段并入 apiKeys 数组（不在其中时插入到首位）。
 * 密钥含脱敏标记（***）时视为无效；无有效密钥返回 null。
 */
function normalizePlatformKeys(p: Record<string, unknown>): string | null {
  const raw = p.apiKeys as string | undefined;
  const legacyKey = p.apiKey as string | undefined;

  const named: { name: string; key: string; whitelisted?: boolean }[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") {
            if (item.trim()) {
              named.push({ name: `密钥${named.length + 1}`, key: item.trim() });
            }
          } else if (
            typeof item === "object" &&
            item !== null &&
            typeof (item as Record<string, unknown>).key === "string"
          ) {
            const k = item as Record<string, unknown>;
            const keyStr = (k.key as string).trim();
            if (keyStr) {
              named.push({
                name:
                  typeof k.name === "string" && k.name.trim()
                    ? k.name.trim()
                    : `密钥${named.length + 1}`,
                key: keyStr,
                ...(k.whitelisted === true ? { whitelisted: true } : {}),
              });
            }
          }
        }
      }
    } catch {
      // 无效 JSON，忽略
    }
  }
  if (legacyKey && typeof legacyKey === "string" && legacyKey.trim()) {
    if (!named.some((n) => n.key === legacyKey)) {
      named.unshift({ name: "主密钥", key: legacyKey });
    }
  }

  if (named.length === 0 || named.some((n) => n.key.includes("***"))) return null;
  return JSON.stringify(named);
}

/**
 * 导入平台配置
 *
 * 按名称去重，密钥含脱敏标记（***）时跳过
 */
async function importPlatforms(
  db: DbClient,
  platforms: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  // 预加载已有平台名称，用于去重
  const existingNames = await db.platforms.findMany({ select: { name: true } });
  const existingNameSet = new Set(existingNames.map((r) => r.name));

  // SSRF 防护（含 DNS Rebinding 检测）
  const validPlatforms: Array<Record<string, unknown>> = [];
  for (const p of platforms) {
    const name = p.name as string;
    const baseUrl = p.baseUrl as string;
    if (!name) {
      skipReasons["缺少必要字段 (name)"] = (skipReasons["缺少必要字段 (name)"] || 0) + 1;
      skipped++;
      continue;
    }
    // 规范化密钥：apiKeys JSON（兼容对象/字符串数组），旧导出数据中的 apiKey 主字段并入
    const normalizedKeys = normalizePlatformKeys(p);
    if (normalizedKeys === null) {
      skipReasons["缺少 API 密钥或已脱敏"] = (skipReasons["缺少 API 密钥或已脱敏"] || 0) + 1;
      skipped++;
      continue;
    }
    if (existingNameSet.has(name)) {
      skipReasons["名称已存在"] = (skipReasons["名称已存在"] || 0) + 1;
      skipped++;
      continue;
    }
    if (baseUrl) {
      const urlCheck = await isSafeUrl(baseUrl);
      if (!urlCheck.safe) {
        skipReasons["URL 指向内网地址"] = (skipReasons["URL 指向内网地址"] || 0) + 1;
        skipped++;
        continue;
      }
    }
    validPlatforms.push({ ...p, _normalizedApiKeys: normalizedKeys });
  }

  skipped += platforms.length - validPlatforms.length;

  if (validPlatforms.length === 0) {
    return { imported, skipped, skipReasons };
  }

  // 批量插入
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < validPlatforms.length; i += BATCH_SIZE) {
    const batch = validPlatforms.slice(i, i + BATCH_SIZE);
    const batchData = batch.map((p) => ({
      id: generateId(),
      name: p.name as string,
      baseUrl: p.baseUrl as string,
      // apiKeys 列在各方言均为长文本（LongText/Text），不截断，避免切断 JSON 导致密钥失效
      apiKeys: p._normalizedApiKeys as string,
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
    }));

    try {
      const result = await db.platforms.createMany({ data: batchData });
      imported += result.count;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] 批量导入平台失败:", errMsg);
      const shortErr = errMsg.length > 100 ? errMsg.slice(0, 100) + "..." : errMsg;
      skipReasons[shortErr] = (skipReasons[shortErr] || 0) + batch.length;
      skipped += batch.length;
    }
  }

  return { imported, skipped, skipReasons };
}

/**
 * 导入模型映射
 *
 * 按 alias 去重，使用 createMany 批量执行
 */
async function importModelMaps(
  db: DbClient,
  modelMaps: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  // 预加载已有 alias，用于去重
  const existingAliases = await db.modelMappings.findMany({ select: { alias: true } });
  const existingAliasSet = new Set(existingAliases.map((r) => r.alias));

  const validMaps = modelMaps.filter((m) => {
    const alias = m.alias as string;
    if (!alias) {
      skipReasons["缺少 alias 字段"] = (skipReasons["缺少 alias 字段"] || 0) + 1;
      return false;
    }
    if (existingAliasSet.has(alias)) {
      skipReasons["alias 已存在"] = (skipReasons["alias 已存在"] || 0) + 1;
      return false;
    }
    return true;
  });

  skipped += modelMaps.length - validMaps.length;

  if (validMaps.length === 0) {
    return { imported, skipped, skipReasons };
  }

  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < validMaps.length; i += BATCH_SIZE) {
    const batch = validMaps.slice(i, i + BATCH_SIZE);
    const batchData = batch.map((m) => ({
      id: generateId(),
      alias: m.alias as string,
      targetModel: (m.targetModel as string) || (m.alias as string),
      platformId: (m.platformId as string) || undefined,
      createdAt: now,
      updatedAt: now,
    }));

    try {
      const result = await db.modelMappings.createMany({ data: batchData });
      imported += result.count;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] 批量导入模型映射失败:", errMsg);
      const shortErr = errMsg.length > 100 ? errMsg.slice(0, 100) + "..." : errMsg;
      skipReasons[shortErr] = (skipReasons[shortErr] || 0) + batch.length;
      skipped += batch.length;
    }
  }

  return { imported, skipped, skipReasons };
}

/**
 * 导入套餐模板
 *
 * 按名称去重，使用 createMany 批量执行
 */
async function importPlans(
  db: DbClient,
  plans: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  // 预加载已有名称，用于去重
  const existingNames = await db.plans.findMany({ select: { name: true } });
  const existingNameSet = new Set(existingNames.map((r) => r.name));

  const validPlans = plans.filter((p) => {
    const name = p.name as string;
    if (!name) {
      skipReasons["缺少 name 字段"] = (skipReasons["缺少 name 字段"] || 0) + 1;
      return false;
    }
    if (existingNameSet.has(name)) {
      skipReasons["名称已存在"] = (skipReasons["名称已存在"] || 0) + 1;
      return false;
    }
    return true;
  });

  skipped += plans.length - validPlans.length;

  if (validPlans.length === 0) {
    return { imported, skipped, skipReasons };
  }

  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < validPlans.length; i += BATCH_SIZE) {
    const batch = validPlans.slice(i, i + BATCH_SIZE);
    const batchData = batch.map((p) => ({
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
    }));

    try {
      const result = await db.plans.createMany({ data: batchData });
      imported += result.count;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] 批量导入套餐失败:", errMsg);
      const shortErr = errMsg.length > 100 ? errMsg.slice(0, 100) + "..." : errMsg;
      skipReasons[shortErr] = (skipReasons[shortErr] || 0) + batch.length;
      skipped += batch.length;
    }
  }

  return { imported, skipped, skipReasons };
}

/**
 * 导入 API Keys
 *
 * 按 key 值去重，使用 createMany 批量执行
 */
async function importApiKeys(
  db: DbClient,
  apiKeysData: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  // 预加载已有 key 集合，用于去重
  const existingKeys = await db.apiKeys.findMany({ select: { key: true } });
  const existingKeySet = new Set(existingKeys.map((r) => r.key));

  // 逐条分析跳过原因
  const validKeys = apiKeysData.filter((k) => {
    const key = k.key as string;
    if (!key) {
      skipReasons["缺少 key 字段"] = (skipReasons["缺少 key 字段"] || 0) + 1;
      return false;
    }
    if (key.includes("***")) {
      skipReasons["Key 已脱敏"] = (skipReasons["Key 已脱敏"] || 0) + 1;
      return false;
    }
    if (existingKeySet.has(key)) {
      skipReasons["Key 已存在"] = (skipReasons["Key 已存在"] || 0) + 1;
      return false;
    }
    return true;
  });

  skipped += apiKeysData.length - validKeys.length;

  if (validKeys.length === 0) {
    return { imported, skipped };
  }

  // 批量插入
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < validKeys.length; i += BATCH_SIZE) {
    const batch = validKeys.slice(i, i + BATCH_SIZE);
    const batchData = batch.map((k) => ({
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
      createdAt: now,
      updatedAt: now,
    }));

    try {
      const result = await db.apiKeys.createMany({ data: batchData });
      imported += result.count;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] 批量导入 API Key 失败:", errMsg);
      const shortErr = errMsg.length > 100 ? errMsg.slice(0, 100) + "..." : errMsg;
      skipReasons[shortErr] = (skipReasons[shortErr] || 0) + batch.length;
      skipped += batch.length;
    }
  }

  return { imported, skipped, skipReasons };
}

/**
 * 导入系统配置
 *
 * 按 key 做 upsert（已存在则更新 value，不存在则创建）
 * 跳过敏感配置（admin_reset_password），insert 用 createMany，update 逐条执行
 */
async function importConfigs(
  db: DbClient,
  configs: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  // 预加载已有配置
  const existingConfigs = await db.configs.findMany({ select: { key: true } });
  const existingKeySet = new Set(existingConfigs.map((r) => r.key));

  // 分离插入和更新
  const toInsert: Array<Record<string, unknown>> = [];
  const toUpdate: Array<Record<string, unknown>> = [];

  for (const c of configs) {
    const key = c.key as string;
    const value = c.value as string;

    if (!key || !value) {
      skipReasons["缺少必要字段 (key/value)"] = (skipReasons["缺少必要字段 (key/value)"] || 0) + 1;
      skipped++;
      continue;
    }

    if (key === "admin_reset_password") {
      skipReasons["敏感配置跳过"] = (skipReasons["敏感配置跳过"] || 0) + 1;
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
    const batchData = toInsert.map((c) => ({
      id: generateId(),
      key: c.key as string,
      value: c.value as string,
      updatedAt: c.updatedAt as number,
    }));
    try {
      const result = await db.configs.createMany({ data: batchData });
      imported += result.count;
    } catch (err) {
      console.error("[import] 批量插入配置失败:", err);
      skipped += toInsert.length;
    }
  }

  // 逐条更新已有配置（update 不支持 createMany）
  for (const c of toUpdate) {
    try {
      await db.configs.update({
        where: { key: c.key as string },
        data: { value: c.value as string, updatedAt: c.updatedAt as number },
      });
      imported++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] 更新配置失败:", errMsg);
      const shortErr = errMsg.length > 100 ? errMsg.slice(0, 100) + "..." : errMsg;
      skipReasons[shortErr] = (skipReasons[shortErr] || 0) + 1;
      skipped++;
    }
  }

  return { imported, skipped, skipReasons };
}

// ==================== 导入审计日志 ====================

/** 合理时间戳下限：2024-01-01T00:00:00Z（秒）——早于项目存在的导入时间视为异常数据 */
const MIN_VALID_TS = 1704067200;

/**
 * 将 ISO 时间字符串或 unix 时间戳转换为 unix 秒
 *
 * 仅接受合理范围内的秒级时间戳（2024-01-01 ~ 当前时间 + 1 天），
 * 超出范围（如备份文件中的 2009 年测试数据 1234483200）回退为
 * 当前时间，防止异常时间在日志归档时污染 daily_stats 统计。
 */
function toUnixSeconds(value: unknown): number {
  const now = Math.floor(Date.now() / 1000);
  const maxValidTs = now + 86400;
  if (typeof value === "number" && value > 1_000_000_000) {
    return value >= MIN_VALID_TS && value <= maxValidTs ? value : now;
  }
  if (typeof value === "string") {
    const ts = Math.floor(new Date(value).getTime() / 1000);
    if (!isNaN(ts) && ts >= MIN_VALID_TS && ts <= maxValidTs) return ts;
  }
  return now;
}

/**
 * 导入审计日志
 *
 * 无外键依赖，使用 createMany 批量执行
 * adminId 不存在时置为 null（不阻塞导入）
 */
async function importAuditLogs(
  db: DbClient,
  logs: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  // 预加载已有 adminId 集合，用于外键校验
  const existingAdminRows = await db.admins.findMany({ select: { id: true } });
  const validAdminIds = new Set(existingAdminRows.map((r) => r.id));

  // 分离有效和无效记录，逐条记录跳过原因
  const validLogs: Array<Record<string, unknown>> = [];
  for (const log of logs) {
    if (!log.action) {
      skipReasons["缺少 action 字段"] = (skipReasons["缺少 action 字段"] || 0) + 1;
      skipped++;
    } else {
      validLogs.push(log);
    }
  }

  for (let i = 0; i < validLogs.length; i += BATCH_SIZE) {
    const batch = validLogs.slice(i, i + BATCH_SIZE);
    const batchData = batch.map((log) => {
      const rawAdminId = log.adminId as string | null | undefined;
      return {
        id: generateId(),
        adminId: rawAdminId && validAdminIds.has(rawAdminId) ? rawAdminId : null,
        action: log.action as string,
        detail: truncateStr(log.detail),
        ip: (log.ip as string) || null,
        createdAt: toUnixSeconds(log.createdAt),
      };
    });

    try {
      const result = await db.auditLogs.createMany({ data: batchData });
      imported += result.count;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] 审计日志批量写入失败:", errMsg);
      const shortErr = errMsg.length > 100 ? errMsg.slice(0, 100) + "..." : errMsg;
      skipReasons[shortErr] = (skipReasons[shortErr] || 0) + batch.length;
      skipped += batch.length;
    }
  }

  return { imported, skipped, skipReasons };
}

// ==================== 导入系统事件 ====================

/**
 * 导入系统事件
 *
 * 无外键依赖，使用 createMany 批量执行
 */
async function importSystemEvents(
  db: DbClient,
  events: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  // 分离有效和无效记录，逐条记录跳过原因
  const validEvents: Array<Record<string, unknown>> = [];
  for (const e of events) {
    if (!e.message) {
      skipReasons["缺少 message 字段"] = (skipReasons["缺少 message 字段"] || 0) + 1;
      skipped++;
    } else {
      validEvents.push(e);
    }
  }

  for (let i = 0; i < validEvents.length; i += BATCH_SIZE) {
    const batch = validEvents.slice(i, i + BATCH_SIZE);
    const batchData = batch.map((e) => ({
      id: generateId(),
      level: (e.level as string) || "info",
      message: truncateStr(e.message),
      detail: truncateStr(e.detail),
      createdAt: toUnixSeconds(e.createdAt),
    }));

    try {
      const result = await db.systemEvents.createMany({ data: batchData });
      imported += result.count;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] 系统事件批量写入失败:", errMsg);
      const shortErr = errMsg.length > 100 ? errMsg.slice(0, 100) + "..." : errMsg;
      skipReasons[shortErr] = (skipReasons[shortErr] || 0) + batch.length;
      skipped += batch.length;
    }
  }

  return { imported, skipped, skipReasons };
}

// ==================== 导入请求日志 ====================

/**
 * 导入请求日志
 *
 * 无外键依赖，Promise.all 并发插入（每批50条并行）
 * 导出数据中 duration 字段映射为 latency
 */
async function importRequestLogs(
  db: DbClient,
  logs: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  // 分离有效和无效记录，同时收集需要校验的外键 ID
  const validLogs: Array<Record<string, unknown>> = [];
  const referencedKeyIds = new Set<string>();
  const referencedPlatformIds = new Set<string>();

  for (const log of logs) {
    if (!log.model) {
      skipReasons["缺少 model 字段"] = (skipReasons["缺少 model 字段"] || 0) + 1;
      skipped++;
      continue;
    }
    validLogs.push(log);
    if (log.keyId) referencedKeyIds.add(log.keyId as string);
    if (log.platformId) referencedPlatformIds.add(log.platformId as string);
  }

  // 校验外键：request_logs 有 FOREIGN KEY(key_id) → api_keys(id) 和 FOREIGN KEY(platform_id) → platforms(id)
  // 备份中的旧 ID 在目标库中可能不存在（导入 platforms/apiKeys 时生成了新 UUID），需置 null 避免外键约束失败
  const existingKeyRows = referencedKeyIds.size > 0
    ? await db.apiKeys.findMany({ where: { id: { in: Array.from(referencedKeyIds) } }, select: { id: true } })
    : [];
  const existingKeyIds = new Set(existingKeyRows.map((r) => r.id));

  const existingPlatformRows = referencedPlatformIds.size > 0
    ? await db.platforms.findMany({ where: { id: { in: Array.from(referencedPlatformIds) } }, select: { id: true } })
    : [];
  const existingPlatformIds = new Set(existingPlatformRows.map((r) => r.id));

  // 构建安全的插入数据：外键不存在时置 null
  const buildValues = (log: Record<string, unknown>) => {
    const rawKeyId = (log.keyId as string) || null;
    const rawPlatformId = (log.platformId as string) || null;
    return {
      id: generateId(),
      keyId: rawKeyId && existingKeyIds.has(rawKeyId) ? rawKeyId : null,
      keyName: (log.keyName as string) || null,
      platformId: rawPlatformId && existingPlatformIds.has(rawPlatformId) ? rawPlatformId : null,
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
    };
  };

  for (let i = 0; i < validLogs.length; i += BATCH_SIZE) {
    const batch = validLogs.slice(i, i + BATCH_SIZE);
    const batchData = batch.map((log) => buildValues(log));

    try {
      const result = await db.requestLogs.createMany({ data: batchData });
      imported += result.count;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] 请求日志批量写入失败:", errMsg);
      const shortErr = errMsg.length > 100 ? errMsg.slice(0, 100) + "..." : errMsg;
      skipReasons[shortErr] = (skipReasons[shortErr] || 0) + batch.length;
      skipped += batch.length;
    }
  }

  return { imported, skipped, skipReasons };
}
