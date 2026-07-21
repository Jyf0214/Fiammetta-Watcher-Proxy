/**
 * 平台多密钥管理 — Round-Robin 轮询选择上游 API Key
 *
 * 每个平台可配置一个主密钥（apiKey）和多个附加密钥（apiKeys JSON 数组）。
 * 请求时按 round-robin 轮询，确保各密钥均匀分摊调用量。
 *
 * 密钥支持命名格式：[{name: "密钥1", key: "sk-xxx"}, ...]
 * 兼容旧格式：["sk-xxx", "sk-yyy"]
 *
 * 轮询计数器使用 KV 存储（替代内存 Map），支持 Cloudflare Workers 分布式运行。
 */

import type { KVNamespace } from "@cloudflare/workers-types";

/** 命名密钥格式 */
export interface NamedApiKey {
  name: string;
  key: string;
}

/** 平台密钥配置（从 schema 查询结果构建） */
export interface PlatformKeySource {
  id: string;
  apiKey: string;
  apiKeys: string | null; // JSON 字符串
}

/** KV 中轮询计数器的 key 前缀 */
const COUNTER_KEY_PREFIX = "key_rr:";

/**
 * 从平台数据中获取全部可用密钥（主密钥 + 附加密钥，去空值）
 */
export function getAllKeys(platform: PlatformKeySource): string[] {
  const extraKeys = parseApiKeys(platform.apiKeys);
  const keys = [platform.apiKey, ...extraKeys].filter(
    (k) => typeof k === "string" && k.trim().length > 0
  );
  return keys;
}

/**
 * Round-robin 获取下一个密钥
 *
 * 每次调用自动递增计数器（KV 存储），返回本轮应使用的密钥。
 * 如果平台没有任何有效密钥，返回 null。
 */
export async function getNextKey(env: { KV: KVNamespace }, platform: PlatformKeySource): Promise<string | null> {
  const keys = getAllKeys(platform);
  if (keys.length === 0) return null;

  // 从 KV 读取当前轮询计数器
  const counterKey = `${COUNTER_KEY_PREFIX}${platform.id}`;
  const counterStr = await env.KV.get(counterKey);
  const counter = counterStr ? parseInt(counterStr, 10) : 0;

  const index = counter % keys.length;

  // 递增计数器并写回 KV（TTL 1 小时，自动过期清理）
  await env.KV.put(counterKey, String(counter + 1), { expirationTtl: 3600 });

  return keys[index];
}

/**
 * 获取密钥总数（用于前端展示）
 */
export function getKeyCount(platform: PlatformKeySource): number {
  return getAllKeys(platform).length;
}

/**
 * 解析 apiKeys JSON 字符串为字符串数组（容错处理，兼容新旧格式）
 *
 * 新格式：[{name: "密钥1", key: "sk-xxx"}, ...]
 * 旧格式：["sk-xxx", "sk-yyy"]
 */
export function parseApiKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // 兼容新格式：对象数组 [{name, key}]
      if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null && "key" in parsed[0]) {
        return parsed
          .filter((k): k is NamedApiKey => typeof k === "object" && k !== null && typeof k.key === "string" && k.key.trim().length > 0)
          .map((k) => k.key);
      }
      // 旧格式：字符串数组 ["key1", "key2"]
      return parsed.filter((k): k is string => typeof k === "string" && k.trim().length > 0);
    }
  } catch {
    // JSON 解析失败，忽略
  }
  return [];
}

/**
 * 解析 apiKeys JSON 字符串为命名密钥数组（容错处理）
 */
export function parseNamedApiKeys(raw: string | null | undefined): NamedApiKey[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // 新格式：对象数组 [{name, key}]
      if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null && "key" in parsed[0]) {
        return parsed.filter((k): k is NamedApiKey =>
          typeof k === "object" && k !== null &&
          typeof k.key === "string" && k.key.trim().length > 0
        );
      }
      // 旧格式：字符串数组 ["key1", "key2"]，自动命名
      return parsed
        .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
        .map((k, i) => ({ name: `密钥${i + 1}`, key: k }));
    }
  } catch {
    // JSON 解析失败，忽略
  }
  return [];
}

/**
 * 将密钥字符串数组序列化为 JSON 字符串（存储到数据库，使用旧格式）
 */
export function serializeApiKeys(keys: string[]): string {
  return JSON.stringify(keys.filter((k) => typeof k === "string" && k.trim().length > 0));
}

/**
 * 将命名密钥数组序列化为 JSON 字符串（存储到数据库）
 */
export function serializeNamedApiKeys(keys: NamedApiKey[]): string {
  const validKeys = keys.filter(
    (k) => typeof k === "object" && k !== null &&
      typeof k.key === "string" && k.key.trim().length > 0
  );
  return JSON.stringify(validKeys);
}

/**
 * 为密钥自动生成名称（密钥1、密钥2...）
 */
export function generateKeyName(existingNames: string[]): string {
  let index = 1;
  while (existingNames.includes(`密钥${index}`)) {
    index++;
  }
  return `密钥${index}`;
}
