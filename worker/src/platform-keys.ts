/**
 * 平台多密钥管理 — 轮询选择上游 API Key
 *
 * 每个平台可配置一个主密钥（apiKey）和多个附加密钥（apiKeys JSON 数组）。
 * 请求时按 round-robin 轮询，确保各密钥均匀分摊调用量。
 */

import type { PlatformConfig } from "@/lib/types";
import type { WorkerEnv } from "./config";

/** 命名密钥格式 */
export interface NamedApiKey {
  name: string;
  key: string;
}

/** 每个平台独立的轮询计数器（内存态，重启归零） */
const counters = new Map<string, number>();

// ==================== Key 白名单机制 ====================

/** 白名单 Key 集合（内存态，可通过 D1 加载） */
const whitelistedKeys = new Set<string>();

/** 白名单 Key 降级冷却（收到429时不封禁，但临时降低优先级） */
const whitelistedKeyCooldowns = new Map<string, number>();

const WHITELISTED_KEY_COOLDOWN_MS = 2 * 60 * 1000; // 白名单 Key 降级 2 分钟

/**
 * 加载白名单（从所有平台的 apiKeys JSON 中读取 whitelisted 标记）
 */
export async function loadWhitelist(db: D1Database, env?: WorkerEnv): Promise<void> {
  try {
    const { createDb } = await import("@/lib/prisma");
    const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
    try {
      const platforms = await prisma.platforms.findMany({
        select: { apiKeys: true },
      });
      whitelistedKeys.clear();
      for (const p of platforms) {
        if (!p.apiKeys) continue;
        try {
          const arr = JSON.parse(p.apiKeys);
          if (!Array.isArray(arr)) continue;
          for (const item of arr) {
            if (
              typeof item === "object" &&
              item !== null &&
              typeof item.key === "string" &&
              item.key.trim() &&
              item.whitelisted === true
            ) {
              whitelistedKeys.add(item.key.trim());
            }
          }
        } catch { /* ignore */ }
      }
      console.log(`[platform-keys] 已加载 ${whitelistedKeys.size} 个白名单 Key`);
    } catch (err) {
    console.error("[platform-keys] 加载白名单失败:", err);
  }
}

/**
 * 检查 Key 是否在白名单中
 */
export function isKeyWhitelisted(key: string): boolean {
  return whitelistedKeys.has(key);
}

/**
 * 获取当前白名单（只读副本）
 */
export function getWhitelist(): string[] {
  return Array.from(whitelistedKeys);
}

// ==================== Key 封禁机制（429 专用） ====================

/**
 * Key 封禁到期时间戳（内存态，重启归零）
 *
 * 已知限制：Worker 冷启动后封禁状态丢失，被封禁的 Key 可能立即恢复使用。
 * 这是 Cloudflare Workers 无状态架构的固有限制。
 * 如需持久化封禁状态，可使用 KV 存储（增加一次网络往返）。
 */
const keyCooldowns = new Map<string, number>();

const DEFAULT_KEY_BAN_MS = 5 * 60 * 1000; // 5 分钟

/**
 * 封禁指定 Key（收到429时调用）
 * 白名单 Key 不会被封禁，只会被临时降级
 */
export function banKey(key: string, durationMs: number = DEFAULT_KEY_BAN_MS): void {
  if (isKeyWhitelisted(key)) {
    // 白名单 Key：不封禁，只降级
    whitelistedKeyCooldowns.set(key, Date.now() + WHITELISTED_KEY_COOLDOWN_MS);
    return;
  }
  keyCooldowns.set(key, Date.now() + durationMs);
}

/**
 * 检查 Key 是否处于封禁状态（白名单 Key 永远不会被封禁）
 */
export function isKeyBanned(key: string): boolean {
  if (isKeyWhitelisted(key)) return false;

  const expireAt = keyCooldowns.get(key);
  if (!expireAt) return false;
  if (Date.now() >= expireAt) {
    keyCooldowns.delete(key);
    return false;
  }
  return true;
}

/**
 * 检查 Key 是否处于降级状态（白名单 Key 收到429后临时降低优先级）
 */
export function isKeyDeprioritized(key: string): boolean {
  const expireAt = whitelistedKeyCooldowns.get(key);
  if (!expireAt) return false;
  if (Date.now() >= expireAt) {
    whitelistedKeyCooldowns.delete(key);
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
 * 优先级：非白名单正常 Key > 白名单正常 Key > 白名单降级 Key
 * 跳过已封禁的 Key。如果平台没有可用密钥，返回 null。
 */
export function getNextKey(platform: PlatformConfig): string | null {
  const allKeys = getAllKeys(platform);
  if (allKeys.length === 0) return null;

  const counter = counters.get(platform.id) ?? 0;

  // 优先级1：非白名单、未封禁、未降级的 Key
  for (let i = 0; i < allKeys.length; i++) {
    const index = (counter + i) % allKeys.length;
    const key = allKeys[index];
    if (!isKeyWhitelisted(key) && !isKeyBanned(key) && !isKeyDeprioritized(key)) {
      counters.set(platform.id, counter + i + 1);
      return key;
    }
  }

  // 优先级2：白名单中未降级的 Key
  for (let i = 0; i < allKeys.length; i++) {
    const index = (counter + i) % allKeys.length;
    const key = allKeys[index];
    if (isKeyWhitelisted(key) && !isKeyDeprioritized(key)) {
      counters.set(platform.id, counter + i + 1);
      return key;
    }
  }

  // 优先级3：白名单中已降级的 Key（最后手段）
  for (let i = 0; i < allKeys.length; i++) {
    const index = (counter + i) % allKeys.length;
    const key = allKeys[index];
    if (isKeyWhitelisted(key) && isKeyDeprioritized(key)) {
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
 * 优先级：非白名单正常 Key > 白名单正常 Key > 白名单降级 Key
 * 排除已尝试过和已封禁的密钥。
 */
export function getRandomKeyExcept(
  platform: PlatformConfig,
  excludeKeys: Set<string>
): string | null {
  const allKeys = getAllKeys(platform);

  // 优先级1：非白名单、未封禁、未降级
  const tier1 = allKeys.filter(
    (k) => !excludeKeys.has(k) && !isKeyWhitelisted(k) && !isKeyBanned(k) && !isKeyDeprioritized(k)
  );
  if (tier1.length > 0) return tier1[Math.floor(Math.random() * tier1.length)];

  // 优先级2：白名单中未降级
  const tier2 = allKeys.filter(
    (k) => !excludeKeys.has(k) && isKeyWhitelisted(k) && !isKeyDeprioritized(k)
  );
  if (tier2.length > 0) return tier2[Math.floor(Math.random() * tier2.length)];

  // 优先级3：白名单中已降级
  const tier3 = allKeys.filter(
    (k) => !excludeKeys.has(k) && isKeyWhitelisted(k) && isKeyDeprioritized(k)
  );
  if (tier3.length > 0) return tier3[Math.floor(Math.random() * tier3.length)];

  return null;
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
