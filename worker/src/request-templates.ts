/**
 * 请求模板加载与应用
 *
 * 从 D1 configs 表读取模板（key: system:request_templates），
 * 缓存 30 秒，按模型 ID（支持通配符）匹配后深度合并到上游请求体。
 */

import { createDb } from "@/lib/prisma";
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
}

// ==================== 缓存 ====================

let templateCache: RequestTemplate[] | null = null;
let lastRefresh = 0;
let cachedUpdatedAt: number | null = null;
const CACHE_TTL = 30_000;

// ==================== 深度合并 ====================

/** mergeBody 允许合并的字段白名单，防止注入 model/messages/tools 等危险字段 */
const MERGEBODY_ALLOWED_KEYS = new Set([
  "system", "temperature", "top_p", "top_k", "max_tokens", "max_completion_tokens",
  "frequency_penalty", "presence_penalty", "stop", "stream", "stream_options",
  "n", "logprobs", "top_logprobs", "response_format", "seed",
  // 思考控制类参数（deepseek/qwen 等厂商透传），与管理后台 API 白名单保持一致
  "reasoning_effort", "chat_template_kwargs", "extra_body",
]);

/**
 * 过滤 mergeBody 中不在白名单中的键
 */
function sanitizeMergeBody(body: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (MERGEBODY_ALLOWED_KEYS.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * 深度合并两个对象。数组整体替换，不合并元素。
 * 仅允许白名单中的键参与合并。
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const sanitized = sanitizeMergeBody(source);
  const result = { ...target };
  for (const key of Object.keys(sanitized)) {
    const srcVal = sanitized[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      );
    } else {
      result[key] = srcVal;
    }
  }
  return result;
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

/**
 * 手动清除缓存（模板更新后调用）
 */
export function invalidateTemplateCache(): void {
  templateCache = null;
  lastRefresh = 0;
}

// ==================== 模板匹配与应用 ====================

/**
 * 获取适用于指定模型的已启用模板
 */
export function getApplicableTemplates(
  templates: RequestTemplate[],
  modelId: string
): RequestTemplate[] {
  return templates.filter(
    (t) => t.enabled && matchModel(modelId, t.models)
  );
}

/**
 * 将匹配的模板深度合并到请求体中
 */
export function applyTemplates(
  body: Record<string, unknown>,
  templates: RequestTemplate[]
): Record<string, unknown> {
  if (templates.length === 0) return body;

  let result = body;
  for (const template of templates) {
    if (template.mergeBody && Object.keys(template.mergeBody).length > 0) {
      result = deepMerge(result, template.mergeBody);
    }
  }
  return result;
}
