/**
 * 请求模板加载器
 *
 * 从 D1 configs 表读取已启用的请求模板，
 * 使用 KV 缓存（TTL 5 秒），在代理请求构建 upstreamBody 时自动合并模板内容。
 *
 * 典型用途：自动注入 extra_body.chat_template_kwargs.enable_thinking 等字段。
 */

import type { KVNamespace, D1Database } from "@cloudflare/workers-types";
import { createDb } from "../db";
import { configs } from "../db/schema";
import { eq } from "drizzle-orm";

const CONFIG_KEY = "system:request_templates";

/** 请求模板结构 */
export interface RequestTemplate {
  id: string;
  name: string;
  description: string;
  endpoint: string; // "all" | "chat/completions" | "embeddings" | ...
  mergeBody: Record<string, unknown>;
  enabled: boolean;
}

/** KV 缓存 key */
const CACHE_KV_KEY = "tmpl_cache";

/** 缓存 TTL：5 秒 */
const CACHE_TTL_MS = 5_000;

/** 内存缓存（单 Worker 实例内，减少 KV 读取延迟） */
let cachedTemplates: RequestTemplate[] | null = null;
let cacheTime = 0;

/**
 * 加载所有已启用的请求模板
 *
 * 优先使用内存缓存（5秒 TTL），未命中时从 KV 读取，KV 未命中时从 D1 读取。
 *
 * @param env 包含 DB 和 KV 的环境绑定
 */
export async function loadRequestTemplates(
  env: { DB: D1Database; KV: KVNamespace }
): Promise<RequestTemplate[]> {
  const now = Date.now();

  // 1. 内存缓存命中
  if (cachedTemplates !== null && now - cacheTime < CACHE_TTL_MS) {
    return cachedTemplates;
  }

  // 2. 从 KV 读取
  try {
    const kvRaw = await env.KV.get(CACHE_KV_KEY);
    if (kvRaw !== null) {
      const all: RequestTemplate[] = JSON.parse(kvRaw);
      cachedTemplates = all.filter((t) => t.enabled);
      cacheTime = now;
      return cachedTemplates;
    }
  } catch {
    // KV 读取失败，继续查 D1
  }

  // 3. 从 D1 读取（权威数据源）
  try {
    const db = createDb(env.DB);
    const config = await db.select().from(configs).where(eq(configs.key, CONFIG_KEY)).get();
    const all: RequestTemplate[] = config?.value ? JSON.parse(config.value) : [];
    cachedTemplates = all.filter((t) => t.enabled);
    cacheTime = now;

    // 异步写入 KV 缓存（不阻塞主流程）
    env.KV.put(CACHE_KV_KEY, config?.value ?? "[]", {
      expirationTtl: 10,
    }).catch(() => {});

    return cachedTemplates;
  } catch {
    // 查询失败，返回空数组并缓存（避免反复重试）
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
 * @param env 包含 DB 和 KV 的环境绑定
 * @param body 原始请求体
 * @param endpoint 当前请求的端点路径，如 "chat/completions"
 * @returns 合并后的请求体
 */
export async function applyRequestTemplates(
  env: { DB: D1Database; KV: KVNamespace },
  body: Record<string, unknown>,
  endpoint: string
): Promise<Record<string, unknown>> {
  const templates = await loadRequestTemplates(env);
  if (templates.length === 0) return body;

  let result = body;
  for (const template of templates) {
    if (template.endpoint === "all" || template.endpoint === endpoint) {
      result = deepMerge(result, template.mergeBody);
    }
  }
  return result;
}
