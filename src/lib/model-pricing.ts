/**
 * 模型价格表（成本核算）
 *
 * 价格存储于 configs 表 system:model_pricing 键，JSON 结构（美元 / 百万 token）：
 *   { "gpt-4o": { "input": 2.5, "output": 10 }, ... }
 *
 * 请求路径的成本计算：
 * - token.ts 的 recordRequestLog / createUsageTransformer 在拿到 prompt/completion
 *   tokens 后按本模块快照计算 cost，随请求日志批量落库；
 * - 快照经 ensurePricingLoaded 按 TTL 懒加载刷新，加载失败沿用旧快照
 *   （成本核算是尽力而为的附加能力，不得阻断代理请求路径）；
 * - 无价格数据的模型 cost 记 0——不猜默认价，缺价在管理后台价格表中显式补录。
 */

import { getConfig } from "../../worker/src/config";
import type { WorkerEnv } from "../../worker/src/config";
import type { Database } from "@/lib/prisma";

/** configs 表中模型价格表的存储键 */
export const MODEL_PRICING_CONFIG_KEY = "system:model_pricing";

/** 单个模型的价格（美元 / 百万 token） */
export interface ModelPricingEntry {
  input: number;
  output: number;
}

/** 价格表：模型 ID → 价格 */
export type ModelPricingMap = Record<string, ModelPricingEntry>;

/** 价格表条目上限：防御误导入的超大文件拖垮每次请求的快照内存 */
export const MODEL_PRICING_MAX_ENTRIES = 20_000;

/**
 * 解析并校验价格表 JSON。
 *
 * 写入路径（管理 API PUT）与读取路径共用本函数；strict=true 时抛出带原因的
 * 错误（写入前拒绝脏数据），strict=false 时告警并返回已解析的部分/空表
 * （读取路径不因历史脏数据阻断请求）。
 */
export function parseModelPricing(
  raw: string | null | undefined,
  opts: { strict?: boolean } = {}
): ModelPricingMap {
  const strict = opts.strict ?? false;
  if (raw == null || raw === "") return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    if (strict) throw new Error("价格表不是合法 JSON");
    console.warn("[model-pricing] 存储的价格表 JSON 解析失败，按空表处理");
    return {};
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    if (strict) throw new Error("价格表必须是对象（模型 ID → {input, output}）");
    console.warn("[model-pricing] 存储的价格表结构非法，按空表处理");
    return {};
  }
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length > MODEL_PRICING_MAX_ENTRIES) {
    if (strict) throw new Error(`价格表条目数超过上限 ${MODEL_PRICING_MAX_ENTRIES}`);
    console.warn("[model-pricing] 价格表条目数超上限，按空表处理");
    return {};
  }
  const out: ModelPricingMap = {};
  for (const [model, value] of entries) {
    const key = typeof model === "string" ? model.trim() : "";
    if (!key || key.length > 512) {
      if (strict) throw new Error(`非法的模型名: "${String(model).slice(0, 64)}"`);
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      if (strict) throw new Error(`模型 ${key} 的价格必须是 {input, output} 对象`);
      continue;
    }
    const v = value as Record<string, unknown>;
    const input = Number(v.input);
    const output = Number(v.output);
    // 价格必须为非负有限数（0 允许：免费模型显式标 0）
    if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) {
      if (strict) throw new Error(`模型 ${key} 的价格必须是非负数字`);
      continue;
    }
    out[key] = { input, output };
  }
  return out;
}

/**
 * 序列化价格表为存储字符串（键按字典序排序，保证同内容写出的串稳定，
 * 便于配置 updatedAt 失效语义与审计 diff）
 */
export function serializeModelPricing(pricing: ModelPricingMap): string {
  const ordered: ModelPricingMap = {};
  for (const key of Object.keys(pricing).sort()) {
    ordered[key] = pricing[key];
  }
  return JSON.stringify(ordered);
}

/**
 * own-property 判定：价格表为普通对象，客户端可控的模型名可能命中
 * Object.prototype 继承属性（"toString"/"constructor" 等），普通下标访问
 * 会拿到函数/对象并让 cost 变成 NaN 污染统计与批量写入——所有直接命中
 * 必须经过本函数。
 */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 模型 ID 匹配：精确 → 小写 → 查询名取最后一段 "/" 后的短名 →
 * 表键取最后一段短名后比对（LiteLLM 等外部价格源常以 "vendor/model" 命名，
 * 而平台发现/请求里的模型名可能是裸名或带前缀，逐级回退提高命中率）。
 * 最后一级为表内线性扫描，仅在前三级全部未命中时发生；仍无命中返回 undefined。
 */
export function lookupPricing(
  pricing: ModelPricingMap,
  modelId: string
): ModelPricingEntry | undefined {
  if (!modelId) return undefined;
  if (hasOwn(pricing, modelId)) return pricing[modelId];
  const lower = modelId.toLowerCase();
  if (hasOwn(pricing, lower)) return pricing[lower];
  const slash = lower.lastIndexOf("/");
  const queryShort = slash >= 0 && slash < lower.length - 1 ? lower.slice(slash + 1) : "";
  if (queryShort && hasOwn(pricing, queryShort)) return pricing[queryShort];
  // 表键短名扫描：表存 "vendor/model"、请求为裸短名的场景。
  // Object.entries 仅枚举自有可枚举键，天然免疫原型属性名
  for (const [key, entry] of Object.entries(pricing)) {
    const k = key.toLowerCase();
    const ks = k.lastIndexOf("/");
    if (ks >= 0 && ks < k.length - 1 && k.slice(ks + 1) === (queryShort || lower)) {
      return entry;
    }
    if (!queryShort && k === lower) return entry;
  }
  return undefined;
}

const COST_PRECISION = 1_000_000;

/**
 * 按价格表计算单次请求成本（美元），四舍五入到小数点后 6 位。
 * 无价格数据计 0（与 requestLogs.cost 默认值一致）；
 * 结果非有限数兜底 0——NaN 一旦落库会污染 _sum 聚合与同批批量写入。
 */
export function computeCost(
  pricing: ModelPricingMap,
  modelId: string,
  promptTokens: number,
  completionTokens: number
): number {
  const entry = lookupPricing(pricing, modelId);
  if (!entry) return 0;
  const cost =
    ((promptTokens || 0) / COST_PRECISION) * entry.input +
    ((completionTokens || 0) / COST_PRECISION) * entry.output;
  if (!Number.isFinite(cost)) return 0;
  return Math.round(cost * COST_PRECISION) / COST_PRECISION;
}

// ==================== 快照缓存 ====================

const PRICING_TTL_MS = 60_000;

let snapshot: ModelPricingMap = {};
let snapshotLoadedAt = 0;
let loadingPromise: Promise<void> | null = null;

async function loadSnapshot(db: D1Database | Database, env?: WorkerEnv): Promise<void> {
  try {
    const raw = await getConfig(db as D1Database, MODEL_PRICING_CONFIG_KEY, env);
    snapshot = parseModelPricing(raw);
    snapshotLoadedAt = Date.now();
  } catch (err) {
    // 读库失败沿用旧快照（可能为空表）：计 0 成本好过阻断请求路径
    console.error(
      "[model-pricing] 加载价格表失败，沿用旧快照:",
      err instanceof Error ? err.message : String(err)
    );
    snapshotLoadedAt = Date.now();
  }
}

/**
 * 确保价格快照可用：TTL 内直接复用进程内快照；过期则懒加载刷新。
 * 并发调用共享同一加载 Promise，避免冷启动惊群。
 */
export async function ensurePricingLoaded(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<void> {
  if (snapshotLoadedAt > 0 && Date.now() - snapshotLoadedAt < PRICING_TTL_MS) return;
  if (!loadingPromise) {
    loadingPromise = loadSnapshot(db, env).finally(() => {
      loadingPromise = null;
    });
  }
  await loadingPromise;
}

/** 当前快照（同步读取；仅供计算与测试） */
export function getPricingSnapshot(): ModelPricingMap {
  return snapshot;
}

/** 重置快照缓存（测试用） */
export function resetPricingCacheForTests(): void {
  snapshot = {};
  snapshotLoadedAt = 0;
  loadingPromise = null;
}
