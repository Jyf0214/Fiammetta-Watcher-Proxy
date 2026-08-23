/**
 * 请求模板加载与应用
 *
 * 从 D1 configs 表读取模板（key: system:request_templates），
 * 缓存 30 秒，按模型 ID（支持通配符）匹配后深度合并到上游请求体。
 */

import { createDb } from "@/lib/prisma";
import {
  CHAT_MERGEBODY_ALLOWED_KEYS,
  RESPONSES_MERGEBODY_ALLOWED_KEYS,
} from "@/lib/request-template-whitelist";
import type { WorkerEnv } from "./config";

// ==================== 类型 ====================

export interface RequestTemplate {
  id: string;
  name: string;
  description: string;
  /** 适用的模型 ID 列表，支持通配符（如 "gpt-*"、"*"） */
  models: string[];
  mergeBody: Record<string, unknown>;
  enabled: boolean;
  /** 模板适用端点类型：chat=Chat Completions 等普通 v1/chat，responses=Responses API；缺省兼容为 chat */
  type?: "chat" | "responses";
}

// ==================== 缓存 ====================

let templateCache: RequestTemplate[] | null = null;
let lastRefresh = 0;
let cachedUpdatedAt: number | null = null;
/** 请求模板缓存 TTL：模板极少变化，延长至 120 秒 */
const CACHE_TTL = 120_000;

/**
 * 主动失效模板缓存（管理后台保存模板后调用）
 */
export function invalidateTemplatesCache(): void {
  lastRefresh = 0;
}

// ==================== 深度合并 ====================

// mergeBody 字段白名单统一从 @/lib/request-template-whitelist 引入（单一来源），
// 与管理后台 API 清洗共用同一集合。anthropic 上游平台模板在转换前应用，
// OpenAI 专属字段（stream_options/n/response_format 等）会被转换白名单剥离，
// 仅 system/temperature/top_p/top_k/max_tokens/stop/tools/tool_choice 生效。

/**
 * 判断模板是否为 responses 类型（缺省兼容为 chat）
 */
function isResponsesTemplate(t: RequestTemplate): boolean {
  return t.type === "responses";
}

/**
 * 获取模板对应的白名单集合
 */
function getAllowedKeysForTemplate(t: RequestTemplate): Set<string> {
  return isResponsesTemplate(t) ? RESPONSES_MERGEBODY_ALLOWED_KEYS : CHAT_MERGEBODY_ALLOWED_KEYS;
}

/**
 * 兼容旧模板：缺省 type 视为 chat，并提供过滤时的类型解析
 */
function sanitizeMergeBodyForTemplate(body: Record<string, unknown>, template: RequestTemplate): Record<string, unknown> {
  const allowed = getAllowedKeysForTemplate(template);
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (allowed.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * 纯结构递归合并：白名单只在入口处过滤一次（仅约束顶层键名），
 * 嵌套层不得重复过滤，否则 response_format.type 等子键会被误删，
 * 导致模板对客户端已有字段的覆盖静默失效。数组整体替换，不合并元素。
 */
function mergeSanitized(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = mergeSanitized(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      );
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * 按模板类型深度合并（模板内已携带 type，按模板自身白名单过滤）
 */
function deepMergeForTemplate(
  target: Record<string, unknown>,
  template: RequestTemplate
): Record<string, unknown> {
  return mergeSanitized(target, sanitizeMergeBodyForTemplate(template.mergeBody, template));
}

// ==================== 模型通配符匹配 ====================

/**
 * 将通配符模式转为正则表达式
 * "gpt-*" → /^gpt-.*$/ ；"*" → /^.*$/
 */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = "^" + escaped.replace(/\*/g, ".*") + "$";
  return new RegExp(regexStr, "i");
}

/**
 * 检查模型 ID 是否匹配模式列表
 */
export function matchModel(
  modelId: string,
  patterns: string[]
): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((p) => patternToRegex(p).test(modelId));
}

// ==================== 模板加载 ====================

const CONFIG_KEY = "system:request_templates";

/**
 * 从 D1 加载模板列表（带缓存）
 *
 * 缓存未过期时先用 configs.updatedAt 做廉价失效检查：管理后台每次保存
 * 模板都会更新 updatedAt，发生变化即强制重载，保证保存后立即生效。
 */
export async function loadTemplates(
  db: D1Database,
  env?: WorkerEnv
): Promise<RequestTemplate[]> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  const now = Date.now();

  if (templateCache !== null && now - lastRefresh < CACHE_TTL) {
    try {
      const meta = await prisma.configs.findFirst({
        where: { key: CONFIG_KEY },
        select: { updatedAt: true },
      });
      if ((meta?.updatedAt ?? null) === cachedUpdatedAt) {
        return templateCache;
      }
    } catch (err) {
      // 失效检查失败时退回 TTL 缓存
      console.error("[request-templates] 缓存失效检查失败，使用缓存:", err);
      return templateCache;
    }
  }

  try {
    const row = await prisma.configs.findFirst({
      where: { key: CONFIG_KEY },
      select: { value: true, updatedAt: true },
    });

    if (!row || !row.value) {
      templateCache = [];
      cachedUpdatedAt = row?.updatedAt ?? null;
      lastRefresh = now;
      return templateCache;
    }

    const parsed = JSON.parse(row.value);
    templateCache = Array.isArray(parsed) ? parsed : [];
    cachedUpdatedAt = row.updatedAt;
    lastRefresh = now;
  } catch (err) {
    console.error("[request-templates] 加载模板失败:", err);
    templateCache = [];
    cachedUpdatedAt = null;
    lastRefresh = now;
  }

  return templateCache;
}

// ==================== 模板匹配与应用 ====================

/**
 * 获取适用于指定模型的已启用模板（按端点类型过滤）
 * type 缺省兼容为 chat：未设置 type 的旧模板仅在 chat 链路生效，responses 链路不命中
 */
export function getApplicableTemplates(
  templates: RequestTemplate[],
  modelId: string,
  type: "chat" | "responses" = "chat"
): RequestTemplate[] {
  return templates.filter(
    (t) => t.enabled && matchModel(modelId, t.models) && (t.type ?? "chat") === type
  );
}

/**
 * 将匹配的模板深度合并到请求体中（按模板自身 type 选择白名单）
 */
export function applyTemplates(
  body: Record<string, unknown>,
  templates: RequestTemplate[]
): Record<string, unknown> {
  if (templates.length === 0) return body;

  let result = body;
  for (const template of templates) {
    if (template.mergeBody && Object.keys(template.mergeBody).length > 0) {
      result = deepMergeForTemplate(result, template);
    }
  }
  return result;
}
