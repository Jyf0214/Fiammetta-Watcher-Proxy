/**
 * 请求模板加载器
 *
 * 从 Config 表读取已启用的请求模板，
 * 在代理请求构建 upstreamBody 时自动合并模板内容。
 *
 * 典型用途：自动注入 extra_body.chat_template_kwargs.enable_thinking 等字段。
 */

import { prisma } from "./prisma";

const CONFIG_KEY = "system:request_templates";

export interface RequestTemplate {
  id: string;
  name: string;
  description: string;
  endpoint: string; // "all" | "chat/completions" | "embeddings" | ...
  mergeBody: Record<string, unknown>;
  enabled: boolean;
}

// 简单内存缓存，避免每次请求都查 DB
let cachedTemplates: RequestTemplate[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5_000; // 5 秒缓存

/**
 * 加载所有已启用的请求模板
 */
export async function loadRequestTemplates(): Promise<RequestTemplate[]> {
  const now = Date.now();
  if (cachedTemplates !== null && now - cacheTime < CACHE_TTL_MS) {
    return cachedTemplates;
  }

  try {
    const config = await prisma.config.findUnique({ where: { key: CONFIG_KEY } });
    const all: RequestTemplate[] = config?.value ? JSON.parse(config.value) : [];
    cachedTemplates = all.filter((t) => t.enabled);
    cacheTime = now;
    return cachedTemplates;
  } catch {
    cachedTemplates = [];
    cacheTime = now;
    return [];
  }
}

/**
 * 清除模板缓存（模板变更后调用）
 */
export function clearTemplateCache(): void {
  cachedTemplates = null;
  cacheTime = 0;
}

/**
 * 深度合并：将 source 的值递归合并到 target 中
 * - 对象类型：递归合并
 * - 其他类型：source 覆盖 target
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sVal = source[key];
    const tVal = result[key];
    if (
      sVal &&
      typeof sVal === "object" &&
      !Array.isArray(sVal) &&
      tVal &&
      typeof tVal === "object" &&
      !Array.isArray(tVal)
    ) {
      result[key] = deepMerge(
        tVal as Record<string, unknown>,
        sVal as Record<string, unknown>
      );
    } else {
      result[key] = sVal;
    }
  }
  return result;
}

/**
 * 将匹配的模板内容合并到请求体中
 *
 * @param body - 原始请求体
 * @param endpoint - 当前请求的端点路径，如 "chat/completions"
 * @returns 合并后的请求体
 */
export async function applyRequestTemplates(
  body: Record<string, unknown>,
  endpoint: string
): Promise<Record<string, unknown>> {
  const templates = await loadRequestTemplates();
  if (templates.length === 0) return body;

  let result = body;
  for (const template of templates) {
    if (template.endpoint === "all" || template.endpoint === endpoint) {
      result = deepMerge(result, template.mergeBody);
    }
  }
  return result;
}
