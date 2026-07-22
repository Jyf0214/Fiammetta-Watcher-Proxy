/**
 * 平台多密钥管理 — 轮询选择上游 API Key
 *
 * 每个平台可配置一个主密钥（apiKey）和多个附加密钥（apiKeys JSON 数组）。
 * 请求时按 round-robin 轮询，确保各密钥均匀分摊调用量。
 */

import type { PlatformConfig } from "@/lib/types";

/** 命名密钥格式 */
export interface NamedApiKey {
  name: string;
  key: string;
}

/** 每个平台独立的轮询计数器（内存态，重启归零） */
const counters = new Map<string, number>();

/**
 * 获取平台全部可用密钥（主密钥 + 附加密钥，去空值）
 */
export function getAllKeys(platform: PlatformConfig): string[] {
  const keys = [platform.apiKey, ...platform.apiKeys].filter(
    (k) => typeof k === "string" && k.trim().length > 0
  );
  return keys;
}

/**
 * Round-robin 获取下一个密钥
 *
 * 每次调用自动递增计数器，返回本轮应使用的密钥。
 * 如果平台没有任何有效密钥，返回 null。
 */
export function getNextKey(platform: PlatformConfig): string | null {
  const keys = getAllKeys(platform);
  if (keys.length === 0) return null;

  const counter = counters.get(platform.id) ?? 0;
  const index = counter % keys.length;
  counters.set(platform.id, counter + 1);
  return keys[index];
}

/**
 * 解析 apiKeys JSON 字符串为字符串数组（容错处理，兼容新旧格式）
 */
export function parseApiKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // 新格式：对象数组 [{name, key}]
      if (parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null && "key" in parsed[0]) {
        return parsed
          .filter(
            (k): k is NamedApiKey =>
              typeof k === "object" &&
              k !== null &&
              typeof k.key === "string" &&
              k.key.trim().length > 0
          )
          .map((k) => k.key);
      }
      // 旧格式：字符串数组 ["key1", "key2"]
      return parsed.filter(
        (k): k is string => typeof k === "string" && k.trim().length > 0
      );
    }
  } catch {
    // JSON 解析失败，忽略
  }
  return [];
}
