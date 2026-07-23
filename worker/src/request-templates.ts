/**
 * 请求模板加载与应用
 *
 * 从 D1 configs 表读取模板（key: system:request_templates），
 * 缓存 30 秒，按模型 ID（支持通配符）匹配后深度合并到上游请求体。
 */

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
const CACHE_TTL = 30_000;

// ==================== 深度合并 ====================

/**
 * 深度合并两个对象。数组整体替换，不合并元素。
 */
function deepMerge(
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
 */
export async function loadTemplates(
  db: D1Database
): Promise<RequestTemplate[]> {
  const now = Date.now();
  if (templateCache !== null && now - lastRefresh < CACHE_TTL) {
    return templateCache;
  }

  try {
    const row = await db
      .prepare(`SELECT value FROM configs WHERE key = ?`)
      .bind(CONFIG_KEY)
      .first<{ value: string }>();

    if (!row || !row.value) {
      templateCache = [];
      lastRefresh = now;
      return templateCache;
    }

    const parsed = JSON.parse(row.value);
    templateCache = Array.isArray(parsed) ? parsed : [];
    lastRefresh = now;
  } catch (err) {
    console.error("[request-templates] 加载模板失败:", err);
    templateCache = [];
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
