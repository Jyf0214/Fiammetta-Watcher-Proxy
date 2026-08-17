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
    platformModels?: ImportResult;
    apiKeys?: ImportResult;
    configs?: ImportResult;
    auditLogs?: ImportResult;
    requestLogs?: ImportResult;
    dailyStats?: ImportResult;
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

/** 单次导入各类型数量上限（避免超大导入导致 Cloudflare Workers CPU 超时 CF1102） */
const MAX_PER_TYPE: Record<string, number> = {
  platforms: 500,
  modelMaps: 1000,
  platformModels: 5000,
  apiKeys: 5000,
  configs: 200,
  auditLogs: 10000,
  requestLogs: 10000,
  dailyStats: 10000,
};

/** 单次导入总记录数上限 */
const MAX_TOTAL_RECORDS = 50000;

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
    let totalRecordsCount = 0;
    for (const [type, max] of Object.entries(MAX_PER_TYPE)) {
      const arr = body[type];
      if (!Array.isArray(arr)) continue;
      const count = arr.length;
      totalRecordsCount += count;
      if (count > max) {
        res.status(400).json({
          success: false,
          error: `${type} 数量 (${count}) 超过单次导入上限 (${max})，请分批导入`,
        });
        return;
      }
    }
    if (totalRecordsCount > MAX_TOTAL_RECORDS) {
      res.status(400).json({
        success: false,
        error: `总记录数 (${totalRecordsCount}) 超过单次导入上限 (${MAX_TOTAL_RECORDS})，请分批导入`,
      });
      return;
    }

    const db = await createDb();

    // 流式响应：边处理边推送进度
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    // no-transform：与 v1 代理 SSE 同理，阻止 next start 内置 gzip 缓冲进度事件
    res.setHeader("Cache-Control", "no-cache, no-transform");
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
      { key: "platformModels", data: body.platformModels, fn: importPlatformModels },
      { key: "configs", data: body.configs, fn: importConfigs },
      { key: "apiKeys", data: body.apiKeys, fn: importApiKeys },
      { key: "auditLogs", data: body.auditLogs, fn: importAuditLogs },
      { key: "requestLogs", data: body.requestLogs, fn: importRequestLogs },
      { key: "dailyStats", data: body.dailyStats, fn: importDailyStats },
    ];

    // 总记录数（与上限检查一致：仅统计数组类型的记录）
    const totalRecords = totalRecordsCount;

    const result: FullImportResult = {
      success: true,
      message: "导入完成",
      details: {},
    };

    let totalProcessed = 0;

    // 本次请求重新累积导入 id：模块级 Set 若跨请求保留，下一次导入时残留 id
    // 会被当作「本批已导入」的平台/Key 引用，插入时外键违反导致整批莫名失败
    importedPlatformIds.clear();
    importedApiKeyIds.clear();

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
        console.error(`[import] 导入 ${step.key} 失败:`, err instanceof Error ? err.message : String(err));
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
      console.warn("[POST /api/admin/import] 审计日志写入失败（不影响导入）:", auditErr instanceof Error ? auditErr.message : String(auditErr));
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
    console.error("[POST /api/admin/import] 导入数据失败:", err instanceof Error ? err.message : String(err));
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

/** 合理时间戳下限：2024-01-01T00:00:00Z（秒）——早于项目存在的导入时间视为异常数据 */
const MIN_VALID_TS = 1704067200;

/** 枚举白名单：与运行期代码实际读取的值一致 */
const VALID_PLATFORM_TYPES = new Set(["openai", "azure", "custom", "anthropic"]);
const VALID_KEY_STATUSES = new Set(["active", "disabled"]);
const VALID_RESET_PERIODS = new Set(["daily", "monthly", "never"]);

/** Prisma Int 字段为 32 位有符号（TiDB/MySQL INT），超出会整批失败 */
const MAX_INT_VALUE = 2147483647;

// 本次导入产生的新 id 集合（按步骤顺序传递：platforms → modelMaps/requestLogs/platformModels
// 的外键校验需要知道「本次导入的 platform id」，仅查已有库会把新导入的引用误判为悬空置 null）
const importedPlatformIds = new Set<string>();
const importedApiKeyIds = new Set<string>();

/** Float 字段安全上界：双精度可精确表示范围内，避免科学计数法溢出 */
const MAX_FLOAT_VALUE = 1e15;

/** 非负整数（含 0）；null/undefined/空串/负数/NaN/超界/非数字返回 null */
export function sanitizeNonNegativeInt(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= MAX_INT_VALUE ? Math.floor(n) : null;
}

/** 非负有限数值（Float 字段，如 cost）；超界返回 null */
export function sanitizeNonNegativeFloat(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= MAX_FLOAT_VALUE ? n : null;
}

/** 布尔值：仅接受 true/false，其余（含字符串 "false"）回退默认值 */
export function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** 枚举白名单：命中返回原值，否则回退默认值 */
export function sanitizeEnum(
  value: unknown,
  valid: Set<string>,
  fallback: string
): string {
  return typeof value === "string" && valid.has(value) ? value : fallback;
}

/** 字符串字段：非字符串返回空串；超长截断 */
export function sanitizeString(value: unknown, maxLen = VARCHAR_MAX): string {
  if (typeof value !== "string") return "";
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

/** 可空字符串字段：非字符串或空串返回 null；超长截断 */
export function sanitizeNullableString(
  value: unknown,
  maxLen = VARCHAR_MAX
): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

/** HTTP 状态码：0~599 的非负整数，其余（负数/超范围/非数字）返回 0 */
export function sanitizeHttpStatus(value: unknown): number {
  const n = sanitizeNonNegativeInt(value);
  return n !== null && n <= 599 ? n : 0;
}

/** 过期时间：ISO 字符串或秒级时间戳，合理范围（2024-01-01 ~ 10 年后）保留，非法返回 null */
export function sanitizeExpiresAt(value: unknown): number | null {
  const maxValid = Math.floor(Date.now() / 1000) + 10 * 365 * 86400;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= MIN_VALID_TS && value <= maxValid ? Math.floor(value) : null;
  }
  if (typeof value === "string") {
    const ts = Math.floor(new Date(value).getTime() / 1000);
    if (!isNaN(ts) && ts >= MIN_VALID_TS && ts <= maxValid) return ts;
  }
  return null;
}

/** forwardHeaders：仅接受合法 JSON 字符串数组，否则回退 "[]"（防脏数据影响头透传） */
function sanitizeForwardHeaders(value: unknown): string {
  if (typeof value !== "string" || value === "") return "[]";
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? value : "[]";
  } catch {
    return "[]";
  }
}

/** extraHeaders：仅接受合法 JSON 对象（键值对字符串），否则回退 "{}"（防脏数据影响头覆盖） */
function sanitizeExtraHeaders(value: unknown): string {
  if (typeof value !== "string" || value === "") return "{}";
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "{}";
    for (const v of Object.values(parsed)) {
      if (typeof v !== "string") return "{}";
    }
    return value;
  } catch {
    return "{}";
  }
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

  // 预加载已有平台名称与 id，用于去重与 id 冲突检测
  const existingNames = await db.platforms.findMany({ select: { name: true, id: true } });
  const existingNameSet = new Set(existingNames.map((r) => r.name));
  const existingIdSet = new Set(existingNames.map((r) => r.id));
  // 批内去重：同一次导入中的重复名称只保留第一条
  const batchSeenNames = new Set<string>();
  const batchSeenIds = new Set<string>();

  // SSRF 防护（含 DNS Rebinding 检测）
  const validPlatforms: Array<Record<string, unknown>> = [];
  for (const p of platforms) {
    const name = sanitizeString(p.name);
    if (!name) {
      skipReasons["缺少必要字段 (name)"] = (skipReasons["缺少必要字段 (name)"] || 0) + 1;
      skipped++;
      continue;
    }
    if (existingNameSet.has(name) || batchSeenNames.has(name)) {
      skipReasons["名称已存在"] = (skipReasons["名称已存在"] || 0) + 1;
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
    const baseUrl = sanitizeString(p.baseUrl);
    if (!baseUrl) {
      skipReasons["缺少 baseUrl 字段"] = (skipReasons["缺少 baseUrl 字段"] || 0) + 1;
      skipped++;
      continue;
    }
    const urlCheck = await isSafeUrl(baseUrl);
    if (!urlCheck.safe) {
      skipReasons["URL 指向内网地址"] = (skipReasons["URL 指向内网地址"] || 0) + 1;
      skipped++;
      continue;
    }
    batchSeenNames.add(name);
    validPlatforms.push({ ...p, _name: name, _baseUrl: baseUrl, _normalizedApiKeys: normalizedKeys });
  }

  if (validPlatforms.length === 0) {
    return { imported, skipped, skipReasons };
  }

  // 批量插入
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < validPlatforms.length; i += BATCH_SIZE) {
    const batch = validPlatforms.slice(i, i + BATCH_SIZE);
    const batchData = batch.map((p) => {
      // 保留导出时的原始 id：跨环境恢复时 modelMaps/requestLogs 的 platformId
      // 引用才能继续成立；id 已存在（目标库冲突）或缺失时重生成
      let platformId: string;
      const rawId = sanitizeNullableString(p.id);
      if (rawId && !existingIdSet.has(rawId) && !batchSeenIds.has(rawId)) {
        platformId = rawId;
      } else {
        platformId = generateId();
      }
      batchSeenIds.add(platformId);
      return {
        id: platformId,
        name: p._name as string,
        baseUrl: p._baseUrl as string,
        // apiKeys 列在各方言均为长文本（LongText/Text），不截断，避免切断 JSON 导致密钥失效
        apiKeys: p._normalizedApiKeys as string,
        type: sanitizeEnum(p.type, VALID_PLATFORM_TYPES, "openai"),
        enabled: sanitizeBoolean(p.enabled, true),
        priority: sanitizeNonNegativeInt(p.priority) ?? 0,
        weight: sanitizeNonNegativeInt(p.weight) ?? 1,
        rpmLimit: sanitizeNonNegativeInt(p.rpmLimit),
        tpmLimit: sanitizeNonNegativeInt(p.tpmLimit),
        forwardHeaders: sanitizeForwardHeaders(p.forwardHeaders),
        injectStreamOptions: sanitizeBoolean(p.injectStreamOptions, true),
        reuseUserAgent: sanitizeBoolean(p.reuseUserAgent, false),
        customUserAgent: sanitizeNullableString(p.customUserAgent),
        extraHeaders: sanitizeExtraHeaders(p.extraHeaders),
        status: "healthy",
        failCount: 0,
        // 用户配置字段（运行态除外）：白名单平台与预设来源需随迁移保留，
        // 否则跨环境备份恢复后白名单平台会重新被 429 封禁、预设关联丢失
        whitelisted: sanitizeBoolean(p.whitelisted, false),
        presetId: sanitizeNullableString(p.presetId),
        createdAt: now,
        updatedAt: now,
      };
    });

    try {
      const result = await db.platforms.createMany({ data: batchData });
      imported += result.count;
      // 记录本次导入成功的平台 id，供后续步骤（modelMaps/requestLogs/platformModels）外键校验
      for (const row of batchData) importedPlatformIds.add(row.id as string);
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
  // 批内去重：同一次导入中的重复 alias 只保留第一条
  const batchSeenAliases = new Set<string>();

  // 外键校验：platformId 不存在时置 null，避免悬空引用导致路由 500（此模型不存在）
  // 校验集合 = 已有平台 id ∪ 本次导入的平台 id（导入保留原始 id，新平台引用必须保留）
  const existingPlatforms = await db.platforms.findMany({ select: { id: true } });
  const validPlatformIds = new Set(existingPlatforms.map((r) => r.id));
  for (const pid of importedPlatformIds) validPlatformIds.add(pid);

  // 已有 modelMappings id（保留原始 id 时避免主键冲突）
  const existingMapIds = await db.modelMappings.findMany({ select: { id: true } });
  const existingMapIdSet = new Set(existingMapIds.map((r) => r.id));
  const batchSeenMapIds = new Set<string>();

  const validMaps: Array<Record<string, unknown>> = [];
  for (const m of modelMaps) {
    const alias = sanitizeString(m.alias);
    if (!alias) {
      skipReasons["缺少 alias 字段"] = (skipReasons["缺少 alias 字段"] || 0) + 1;
      skipped++;
      continue;
    }
    if (existingAliasSet.has(alias) || batchSeenAliases.has(alias)) {
      skipReasons["alias 已存在"] = (skipReasons["alias 已存在"] || 0) + 1;
      skipped++;
      continue;
    }
    batchSeenAliases.add(alias);
    validMaps.push(m);
  }

  if (validMaps.length === 0) {
    return { imported, skipped, skipReasons };
  }

  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < validMaps.length; i += BATCH_SIZE) {
    const batch = validMaps.slice(i, i + BATCH_SIZE);
    const batchData = batch.map((m) => {
      const rawPlatformId = sanitizeNullableString(m.platformId);
      // 保留导出时的原始 id（冲突时重生成）
      let mapId: string;
      const rawMapId = sanitizeNullableString(m.id);
      if (rawMapId && !existingMapIdSet.has(rawMapId) && !batchSeenMapIds.has(rawMapId)) {
        mapId = rawMapId;
      } else {
        mapId = generateId();
      }
      batchSeenMapIds.add(mapId);
      return {
        id: mapId,
        alias: sanitizeString(m.alias),
        targetModel: sanitizeString(m.targetModel) || sanitizeString(m.alias),
        platformId: rawPlatformId && validPlatformIds.has(rawPlatformId) ? rawPlatformId : null,
        createdAt: now,
        updatedAt: now,
      };
    });

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
 * 导入平台模型（自动发现结果）
 *
 * 按 (platformId, modelId) 去重（与 platform_models 唯一约束一致）。
 * platformId 不在已有库也不在本次导入的平台集合时跳过，避免悬空引用。
 */
async function importPlatformModels(
  db: DbClient,
  platformModels: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  // 已有记录去重键
  const existingRows = await db.platformModels.findMany({
    select: { platformId: true, modelId: true },
  });
  const existingKeys = new Set(
    existingRows.map((r) => `${r.platformId}\0${r.modelId}`)
  );
  // 平台存在性：已有库 ∪ 本次导入
  const existingPlatformRows = await db.platforms.findMany({ select: { id: true } });
  const validPlatformIds = new Set(existingPlatformRows.map((r) => r.id));
  for (const pid of importedPlatformIds) validPlatformIds.add(pid);

  const batchSeen = new Set<string>();
  const validRows: Array<Record<string, unknown>> = [];
  for (const pm of platformModels) {
    const platformId = sanitizeNullableString(pm.platformId);
    const modelId = sanitizeNullableString(pm.modelId);
    if (!platformId || !modelId) {
      skipReasons["缺少 platformId/modelId 字段"] = (skipReasons["缺少 platformId/modelId 字段"] || 0) + 1;
      skipped++;
      continue;
    }
    if (!validPlatformIds.has(platformId)) {
      skipReasons["platformId 不存在"] = (skipReasons["platformId 不存在"] || 0) + 1;
      skipped++;
      continue;
    }
    const dedupKey = `${platformId}\0${modelId}`;
    if (existingKeys.has(dedupKey) || batchSeen.has(dedupKey)) {
      skipReasons["平台模型已存在"] = (skipReasons["平台模型已存在"] || 0) + 1;
      skipped++;
      continue;
    }
    batchSeen.add(dedupKey);
    validRows.push(pm);
  }

  if (validRows.length === 0) {
    return { imported, skipped, skipReasons };
  }

  // 已有 id（保留原始 id 时避免主键冲突）
  const existingIds = await db.platformModels.findMany({ select: { id: true } });
  const existingIdSet = new Set(existingIds.map((r) => r.id));
  const batchSeenIds = new Set<string>();

  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
    const batch = validRows.slice(i, i + BATCH_SIZE);
    const batchData = batch.map((pm) => {
      let pmId: string;
      const rawId = sanitizeNullableString(pm.id);
      if (rawId && !existingIdSet.has(rawId) && !batchSeenIds.has(rawId)) {
        pmId = rawId;
      } else {
        pmId = generateId();
      }
      batchSeenIds.add(pmId);
      return {
        id: pmId,
        platformId: sanitizeNullableString(pm.platformId) as string,
        modelId: truncateStr(pm.modelId),
        ownedBy: sanitizeNullableString(pm.ownedBy),
        modelName: sanitizeNullableString(pm.modelName),
        type: sanitizeEnum(pm.type, new Set(["chat", "embedding", "image", "audio", "video", "moderation"]), "chat"),
        source: sanitizeEnum(pm.source, new Set(["auto", "manual"]), "auto"),
        enabled: sanitizeBoolean(pm.enabled, true),
        fetchedAt: sanitizeNonNegativeInt(pm.fetchedAt) ?? now,
      };
    });

    try {
      const result = await db.platformModels.createMany({ data: batchData });
      imported += result.count;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] 批量导入平台模型失败:", errMsg);
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
  // 批内去重：同一次导入中的重复 key 只保留第一条（避免唯一约束失败毒死整批）
  const batchSeenKeys = new Set<string>();

  // 逐条分析跳过原因
  const validKeys: Array<Record<string, unknown>> = [];
  for (const k of apiKeysData) {
    const rawKey = k.key;
    if (typeof rawKey !== "string" || rawKey.trim() === "") {
      skipReasons["缺少 key 字段"] = (skipReasons["缺少 key 字段"] || 0) + 1;
      skipped++;
      continue;
    }
    if (rawKey.includes("***")) {
      skipReasons["Key 已脱敏"] = (skipReasons["Key 已脱敏"] || 0) + 1;
      skipped++;
      continue;
    }
    // key 为唯一约束列（TiDB VARCHAR(191)），截断会使密钥永久失效且无提示，超长直接跳过
    if (rawKey.length > VARCHAR_MAX) {
      skipReasons["Key 超长"] = (skipReasons["Key 超长"] || 0) + 1;
      skipped++;
      continue;
    }
    if (existingKeySet.has(rawKey) || batchSeenKeys.has(rawKey)) {
      skipReasons["Key 已存在"] = (skipReasons["Key 已存在"] || 0) + 1;
      skipped++;
      continue;
    }
    batchSeenKeys.add(rawKey);
    validKeys.push(k);
  }

  if (validKeys.length === 0) {
    return { imported, skipped, skipReasons };
  }

  // 批量插入
  const now = Math.floor(Date.now() / 1000);
  // 已有 apiKeys id（保留原始 id 时避免主键冲突）
  const existingKeyIds = await db.apiKeys.findMany({ select: { id: true } });
  const existingKeyIdSet = new Set(existingKeyIds.map((r) => r.id));
  const batchSeenKeyIds = new Set<string>();
  for (let i = 0; i < validKeys.length; i += BATCH_SIZE) {
    const batch = validKeys.slice(i, i + BATCH_SIZE);
    const batchData = batch.map((k) => {
      // 保留导出时的原始 id：requestLogs 的 keyId 引用才能跨环境成立
      let keyId: string;
      const rawKeyId = sanitizeNullableString(k.id);
      if (rawKeyId && !existingKeyIdSet.has(rawKeyId) && !batchSeenKeyIds.has(rawKeyId)) {
        keyId = rawKeyId;
      } else {
        keyId = generateId();
      }
      batchSeenKeyIds.add(keyId);
      return {
        id: keyId,
        key: k.key as string,
        name: sanitizeString(k.name) || "导入的 Key",
        usedTokens: sanitizeNonNegativeInt(k.usedTokens) ?? 0,
        rpmLimit: sanitizeNonNegativeInt(k.rpmLimit),
        tpmLimit: sanitizeNonNegativeInt(k.tpmLimit),
        callLimit: sanitizeNonNegativeInt(k.callLimit),
        callUsed: sanitizeNonNegativeInt(k.callUsed) ?? 0,
        tokenLimit: sanitizeNonNegativeInt(k.tokenLimit),
        resetPeriod: sanitizeEnum(k.resetPeriod, VALID_RESET_PERIODS, "monthly"),
        status: sanitizeEnum(k.status, VALID_KEY_STATUSES, "active"),
        expiresAt: sanitizeExpiresAt(k.expiresAt),
        createdAt: now,
        updatedAt: now,
      };
    });

    try {
      const result = await db.apiKeys.createMany({ data: batchData });
      imported += result.count;
      // 记录本次导入成功的 key id，供 requestLogs 外键校验
      for (const row of batchData) importedApiKeyIds.add(row.id as string);
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
 * 跳过运行期关键配置（system:auto_model_id），
 * 仅允许 system:* 前缀的键（与 /api/admin/config 的写入约束一致，其他键视为异常数据）
 */
const SKIP_IMPORT_CONFIG_KEYS = new Set(["system:auto_model_id"]);
const IMPORT_CONFIG_PREFIX = "system:";

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
    const key = typeof c.key === "string" ? c.key : "";
    const value = c.value;

    if (!key || typeof value !== "string" || value === "") {
      skipReasons["缺少必要字段 (key/value)"] = (skipReasons["缺少必要字段 (key/value)"] || 0) + 1;
      skipped++;
      continue;
    }

    // configs.key 为唯一约束列（TiDB VARCHAR(191)），超长会毒化整批 createMany
    if (key.length > VARCHAR_MAX) {
      skipReasons["配置 key 超长"] = (skipReasons["配置 key 超长"] || 0) + 1;
      skipped++;
      continue;
    }

    if (SKIP_IMPORT_CONFIG_KEYS.has(key)) {
      skipReasons["敏感/运行期配置跳过"] = (skipReasons["敏感/运行期配置跳过"] || 0) + 1;
      skipped++;
      continue;
    }

    if (!key.startsWith(IMPORT_CONFIG_PREFIX)) {
      skipReasons["非 system:* 配置跳过"] = (skipReasons["非 system:* 配置跳过"] || 0) + 1;
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
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] 批量插入配置失败:", errMsg);
      const shortErr = errMsg.length > 100 ? errMsg.slice(0, 100) + "..." : errMsg;
      skipReasons[shortErr] = (skipReasons[shortErr] || 0) + toInsert.length;
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

/**
 * 将 ISO 时间字符串或 unix 时间戳转换为 unix 秒
 *
 * 仅接受合理范围内的秒级时间戳（2024-01-01 ~ 当前时间 + 1 天），
 * 超出范围（如备份文件中的 2009 年测试数据 1234483200）回退为
 * 当前时间，防止异常时间在日志归档时污染 daily_stats 统计。
 */
export function toUnixSeconds(value: unknown): number {
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
        action: truncateStr(log.action),
        detail: truncateStr(log.detail),
        ip: sanitizeNullableString(log.ip, 45),
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

// ==================== 导入请求日志 ====================

/**
 * 导入请求日志
 *
 * 无外键依赖，createMany 分批顺序执行（每批 BATCH_SIZE 条）
 * 导出数据中 duration 字段映射为 latency
 */
export async function importRequestLogs(
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
    if (!sanitizeString(log.model)) {
      skipReasons["缺少 model 字段"] = (skipReasons["缺少 model 字段"] || 0) + 1;
      skipped++;
      continue;
    }
    validLogs.push(log);
    const keyId = sanitizeNullableString(log.keyId);
    const platformId = sanitizeNullableString(log.platformId);
    if (keyId) referencedKeyIds.add(keyId);
    if (platformId) referencedPlatformIds.add(platformId);
  }

  // 校验外键：request_logs 有 FOREIGN KEY(key_id) → api_keys(id) 和 FOREIGN KEY(platform_id) → platforms(id)
  // 校验集合 = 已有 id ∪ 本次导入的 id（导入保留原始 id 后，新插入的 Key/平台引用必须保留）
  const existingKeyRows = referencedKeyIds.size > 0
    ? await db.apiKeys.findMany({ where: { id: { in: Array.from(referencedKeyIds) } }, select: { id: true } })
    : [];
  const existingKeyIds = new Set(existingKeyRows.map((r) => r.id));
  for (const kid of importedApiKeyIds) existingKeyIds.add(kid);

  const existingPlatformRows = referencedPlatformIds.size > 0
    ? await db.platforms.findMany({ where: { id: { in: Array.from(referencedPlatformIds) } }, select: { id: true } })
    : [];
  const existingPlatformIds = new Set(existingPlatformRows.map((r) => r.id));
  for (const pid of importedPlatformIds) existingPlatformIds.add(pid);

  // 已有 requestLogs id（保留原始 id 时避免主键冲突）
  const existingLogIds = await db.requestLogs.findMany({
    where: { id: { in: validLogs.map((l) => sanitizeNullableString(l.id)).filter((x): x is string => !!x) } },
    select: { id: true },
  });
  const existingLogIdSet = new Set(existingLogIds.map((r) => r.id));
  const batchSeenLogIds = new Set<string>();

  // 构建安全的插入数据：外键不存在时置 null，数值字段钳制为合法范围，字符串截断防超长整批失败
  const buildValues = (log: Record<string, unknown>) => {
    const rawKeyId = sanitizeNullableString(log.keyId);
    const rawPlatformId = sanitizeNullableString(log.platformId);
    // 保留导出时的原始 id（冲突时重生成）
    let logId: string;
    const rawLogId = sanitizeNullableString(log.id);
    if (rawLogId && !existingLogIdSet.has(rawLogId) && !batchSeenLogIds.has(rawLogId)) {
      logId = rawLogId;
    } else {
      logId = generateId();
    }
    batchSeenLogIds.add(logId);
    return {
      id: logId,
      keyId: rawKeyId && existingKeyIds.has(rawKeyId) ? rawKeyId : null,
      keyName: sanitizeNullableString(log.keyName),
      platformId: rawPlatformId && existingPlatformIds.has(rawPlatformId) ? rawPlatformId : null,
      model: truncateStr(log.model),
      endpoint: sanitizeNullableString(log.endpoint),
      method: sanitizeNullableString(log.method, 10),
      status: sanitizeHttpStatus(log.status),
      latency: sanitizeNonNegativeInt(log.duration) ?? sanitizeNonNegativeInt(log.latency) ?? 0,
      tokens: sanitizeNonNegativeInt(log.tokens) ?? 0,
      promptTokens: sanitizeNonNegativeInt(log.promptTokens) ?? 0,
      completionTokens: sanitizeNonNegativeInt(log.completionTokens) ?? 0,
      ttft: sanitizeNonNegativeInt(log.ttft) ?? 0,
      cost: sanitizeNonNegativeFloat(log.cost) ?? 0,
      isError: sanitizeBoolean(log.isError, false),
      ipAddress: sanitizeNullableString(log.ipAddress, 45),
      userAgent: sanitizeNullableString(log.userAgent),
      errorMessage: sanitizeNullableString(log.errorMessage),
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

// ==================== 导入每日统计 ====================

/**
 * 导入每日统计数据
 *
 * 按 date + keyId + model 去重（与 daily_stats 唯一约束一致）。
 * platformId 不存在时置 null，避免悬空引用。
 */
async function importDailyStats(
  db: DbClient,
  dailyStats: Array<Record<string, unknown>>
): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};

  // 预加载已有记录的去重键
  const existingRows = await db.dailyStats.findMany({
    select: { date: true, keyId: true, model: true },
  });
  const existingKeys = new Set(
    existingRows.map((r) => `${r.date}\0${r.keyId ?? ""}\0${r.model}`)
  );
  const batchSeen = new Set<string>();

  // 外键校验：platformId 不存在时置 null
  const referencedPlatformIds = new Set<string>();
  for (const s of dailyStats) {
    const pid = sanitizeNullableString(s.platformId);
    if (pid) referencedPlatformIds.add(pid);
  }
  const existingPlatformRows = referencedPlatformIds.size > 0
    ? await db.platforms.findMany({ where: { id: { in: Array.from(referencedPlatformIds) } }, select: { id: true } })
    : [];
  const validPlatformIds = new Set(existingPlatformRows.map((r) => r.id));

  const validStats: Array<Record<string, unknown>> = [];
  for (const s of dailyStats) {
    const date = sanitizeNonNegativeInt(s.date);
    const model = sanitizeString(s.model);
    if (date === null || !model) {
      skipReasons["缺少必要字段 (date/model)"] = (skipReasons["缺少必要字段 (date/model)"] || 0) + 1;
      skipped++;
      continue;
    }
    const keyId = sanitizeNullableString(s.keyId);
    const dedupeKey = `${date}\0${keyId ?? ""}\0${model}`;
    if (existingKeys.has(dedupeKey) || batchSeen.has(dedupeKey)) {
      skipReasons["记录已存在"] = (skipReasons["记录已存在"] || 0) + 1;
      skipped++;
      continue;
    }
    batchSeen.add(dedupeKey);
    validStats.push(s);
  }

  if (validStats.length === 0) {
    return { imported, skipped, skipReasons };
  }

  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < validStats.length; i += BATCH_SIZE) {
    const batch = validStats.slice(i, i + BATCH_SIZE);
    const batchData = batch.map((s) => {
      const rawPlatformId = sanitizeNullableString(s.platformId);
      return {
        id: generateId(),
        date: sanitizeNonNegativeInt(s.date) ?? now,
        keyId: sanitizeNullableString(s.keyId),
        keyName: sanitizeNullableString(s.keyName),
        platformId: rawPlatformId && validPlatformIds.has(rawPlatformId) ? rawPlatformId : null,
        platformName: sanitizeNullableString(s.platformName),
        model: sanitizeString(s.model),
        totalRequests: sanitizeNonNegativeInt(s.totalRequests) ?? 0,
        errorRequests: sanitizeNonNegativeInt(s.errorRequests) ?? 0,
        totalTokens: sanitizeNonNegativeInt(s.totalTokens) ?? 0,
        totalPromptTokens: sanitizeNonNegativeInt(s.totalPromptTokens) ?? 0,
        totalCompletionTokens: sanitizeNonNegativeInt(s.totalCompletionTokens) ?? 0,
        avgTtft: sanitizeNonNegativeFloat(s.avgTtft) ?? 0,
        avgDuration: sanitizeNonNegativeFloat(s.avgDuration) ?? 0,
        avgTps: sanitizeNonNegativeFloat(s.avgTps) ?? 0,
        maxTtft: sanitizeNonNegativeInt(s.maxTtft) ?? 0,
        maxDuration: sanitizeNonNegativeInt(s.maxDuration) ?? 0,
        maxTps: sanitizeNonNegativeFloat(s.maxTps) ?? 0,
        createdAt: sanitizeNonNegativeInt(s.createdAt) ?? now,
      };
    });

    try {
      const result = await db.dailyStats.createMany({ data: batchData });
      imported += result.count;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("[import] 每日统计批量写入失败:", errMsg);
      const shortErr = errMsg.length > 100 ? errMsg.slice(0, 100) + "..." : errMsg;
      skipReasons[shortErr] = (skipReasons[shortErr] || 0) + batch.length;
      skipped += batch.length;
    }
  }

  return { imported, skipped, skipReasons };
}
