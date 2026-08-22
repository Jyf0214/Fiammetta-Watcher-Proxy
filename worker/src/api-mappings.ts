/**
 * 接口映射（API 转换）— 将下游请求按模型通配符转换为对应上游 API 结构
 *
 * 场景：老旧客户端仅支持 /v1/chat/completions，但上游强制要求 /v1/responses 结构。
 * 本模块通过通配符匹配模型名，命中时将下游请求体转换为上游所需 API 格式，并将上游响应逆向转回下游格式，实现透明代理。
 *
 * 存储：configs 表 system:api_mappings，JSON 数组，缓存 30s，与 request-templates 一致。
 */

import { createDb } from "@/lib/prisma";
import type { WorkerEnv } from "./config";

// ==================== 类型 ====================

export type ApiType = "chat" | "responses";

export interface ApiMapping {
  id: string;
  name: string;
  description: string;
  /** 下游模型匹配模式，支持 * 通配（如 "old-model*"、"*"） */
  pattern: string;
  /** 上游目标模型（可为通配符映射的目标，如命中 old-model-123 时取 targetModel + 后缀）；留空或 "*" 表示与下游同模（保持原模型名） */
  targetModel: string;
  /** 下游来源 API（客户端使用的协议） */
  sourceApi: ApiType;
  /** 上游目标 API（上游要求的协议） */
  targetApi: ApiType;
  /** 限定平台（null/undefined 表示不限平台） */
  platformId?: string | null;
  enabled: boolean;
}

// ==================== 缓存 ====================

let mappingCache: ApiMapping[] | null = null;
let lastRefresh = 0;
let cachedUpdatedAt: number | null = null;
/** 接口映射缓存 TTL：映射规则极少变化，延长至 120 秒 */
const CACHE_TTL = 120_000;
const CONFIG_KEY = "system:api_mappings";

/**
 * 主动失效接口映射缓存（管理后台保存映射后调用）
 */
export function invalidateApiMappingsCache(): void {
  lastRefresh = 0;
}

// ==================== 通配符匹配 ====================

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = "^" + escaped.replace(/\*/g, ".*") + "$";
  return new RegExp(regexStr, "i");
}

export function matchApiPattern(modelId: string, pattern: string): boolean {
  if (!pattern) return false;
  return patternToRegex(pattern).test(modelId);
}

/**
 * 解析通配符后缀：用于 targetModel 拼接
 * 例如 pattern "old-*" + requested "old-model-123" => suffix "model-123"
 * 仅当 pattern 以 * 结尾且匹配时有效，否则返回空串
 */
function extractSuffix(requestedModel: string, pattern: string): string {
  if (!pattern.endsWith("*")) return "";
  const prefix = pattern.slice(0, -1);
  if (!requestedModel.toLowerCase().startsWith(prefix.toLowerCase())) return "";
  return requestedModel.slice(prefix.length);
}

// ==================== 加载 ====================

export async function loadApiMappings(
  db: D1Database,
  env?: WorkerEnv
): Promise<ApiMapping[]> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const now = Date.now();

  if (mappingCache !== null && now - lastRefresh < CACHE_TTL) {
    try {
      const meta = await prisma.configs.findFirst({
        where: { key: CONFIG_KEY },
        select: { updatedAt: true },
      });
      if ((meta?.updatedAt ?? null) === cachedUpdatedAt) {
        return mappingCache;
      }
    } catch (err) {
      console.error("[api-mappings] 缓存失效检查失败，使用缓存:", err);
      return mappingCache;
    }
  }

  try {
    const row = await prisma.configs.findFirst({
      where: { key: CONFIG_KEY },
      select: { value: true, updatedAt: true },
    });

    if (!row || !row.value) {
      mappingCache = [];
      cachedUpdatedAt = row?.updatedAt ?? null;
      lastRefresh = now;
      return mappingCache;
    }

    const parsed = JSON.parse(row.value);
    const raw = Array.isArray(parsed) ? parsed : [];
    // 兼容旧数据：过滤非法条目，缺省字段补齐（targetModel 允许空表示同模）
    mappingCache = raw
      .filter((m: any) => m && typeof m.pattern === "string")
      .map((m: any) => ({
        id: String(m.id ?? crypto.randomUUID()),
        name: String(m.name ?? ""),
        description: String(m.description ?? ""),
        pattern: String(m.pattern),
        targetModel: typeof m.targetModel === "string" ? String(m.targetModel).trim() : "",
        sourceApi: m.sourceApi === "responses" ? "responses" : "chat",
        targetApi: m.targetApi === "responses" ? "responses" : "chat",
        platformId: m.platformId ?? null,
        enabled: m.enabled !== false,
      }));
    cachedUpdatedAt = row.updatedAt;
    lastRefresh = now;
  } catch (err) {
    console.error("[api-mappings] 加载失败:", err);
    mappingCache = [];
    cachedUpdatedAt = null;
    lastRefresh = now;
  }

  return mappingCache;
}

// ==================== 匹配 ====================

/**
 * 获取适用于指定请求的接口映射
 * 按下游模型 + 下游 API + 平台 匹配，返回首个命中的 enabled 映射
 * 匹配优先级：精确模式优先于通配，或按存储顺序
 */
export function getApplicableApiMapping(
  mappings: ApiMapping[],
  requestedModel: string,
  sourceApi: ApiType,
  platformId?: string | null
): ApiMapping | null {
  // 按存储顺序遍历，首个匹配即返回（管理后台可通过上下拖动调整优先级，当前按数组顺序）
  for (const m of mappings) {
    if (!m.enabled) continue;
    if (m.sourceApi !== sourceApi) continue;
    if (!matchApiPattern(requestedModel, m.pattern)) continue;
    if (m.platformId && platformId && m.platformId !== platformId) continue;
    // 若映射限定平台但当前路由尚未确定平台，则暂时命中，待平台确定后二次校验
    // 此处不强制校验 platformId 为 null 的放行
    return m;
  }
  return null;
}

/**
 * 根据映射计算上游目标模型（支持通配后缀拼接与同模）
 * 例如 pattern "old-*" + requested "old-123" + targetModel "new-" => "new-123"
 * 若 targetModel 为空、"*" 或与下游同模（同名），则直接返回下游原模型名（保持同模）
 */
export function resolveTargetModel(mapping: ApiMapping, requestedModel: string): string {
  const target = (mapping.targetModel || "").trim();
  // 同模：留空、"*"、"same" 或与 pattern 相同且无通配后缀时，保持下游原模型
  if (!target || target === "*" || target.toLowerCase() === "same") {
    return requestedModel;
  }
  const suffix = extractSuffix(requestedModel, mapping.pattern);
  if (suffix && mapping.pattern.endsWith("*")) {
    if (target.endsWith("*")) {
      return target.slice(0, -1) + suffix;
    }
    return target + suffix;
  }
  return target;
}

// ==================== 辅助 ====================

/**
 * 判断是否需要进行 API 转换（来源与目标 API 不同）
 */
export function needsApiConversion(mapping: ApiMapping | null): boolean {
  if (!mapping) return false;
  return mapping.sourceApi !== mapping.targetApi;
}

/**
 * 获取映射的目标 API 类型
 */
export function getTargetApi(mapping: ApiMapping | null, defaultApi: ApiType): ApiType {
  if (!mapping) return defaultApi;
  return mapping.targetApi;
}
