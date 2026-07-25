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

// ==================== Key 封禁机制（429 专用） ====================

/** Key 封禁到期时间戳（内存态，重启归零） */
const keyCooldowns = new Map<string, number>();

const DEFAULT_KEY_BAN_MS = 5 * 60 * 1000; // 5 分钟

/**
 * 封禁指定 Key（收到429时调用）
 */
export function banKey(key: string, durationMs: number = DEFAULT_KEY_BAN_MS): void {
  keyCooldowns.set(key, Date.now() + durationMs);
}

/**
 * 检查 Key 是否处于封禁状态
 */
export function isKeyBanned(key: string): boolean {
  const expireAt = keyCooldowns.get(key);
  if (!expireAt) return false;
  if (Date.now() >= expireAt) {
    keyCooldowns.delete(key);
    return false;
  }
  return true;
}

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
 * 跳过已封禁的 Key。如果平台没有可用密钥，返回 null。
 */
export function getNextKey(platform: PlatformConfig): string | null {
  const allKeys = getAllKeys(platform);
  if (allKeys.length === 0) return null;

  const counter = counters.get(platform.id) ?? 0;
  for (let i = 0; i < allKeys.length; i++) {
    const index = (counter + i) % allKeys.length;
    const key = allKeys[index];
    if (!isKeyBanned(key)) {
      counters.set(platform.id, counter + i + 1);
      return key;
    }
  }

  // 所有 Key 都被封禁
  counters.set(platform.id, counter + allKeys.length);
  return null;
}

/**
 * 随机获取一个未尝试过的密钥（429 重试用）
 *
 * 从平台的所有密钥中，排除已尝试过和已封禁的密钥，随机选择一个返回。
 * 如果没有可用密钥，返回 null。
 */
export function getRandomKeyExcept(
  platform: PlatformConfig,
  excludeKeys: Set<string>
): string | null {
  const allKeys = getAllKeys(platform);
  const available = allKeys.filter(
    (k) => !excludeKeys.has(k) && !isKeyBanned(k)
  );
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
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
