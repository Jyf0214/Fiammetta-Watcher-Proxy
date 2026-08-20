/**
 * 平台多密钥管理 — 轮询选择上游 API Key
 *
 * 每个平台配置多个密钥（apiKeys JSON 数组，命名对象 [{name, key, whitelisted}]）。
 * 请求时按 round-robin 轮询，确保各密钥均匀分摊调用量。
 */

import type { PlatformConfig, PlatformApiKeyObject } from "@/lib/types";
import type { WorkerEnv } from "./config";
import { keyFingerprint, readPlatformKeyStatus, writePlatformKeyStatus, removePlatformKeyStatus, type PlatformKeyStatus } from "@/lib/key-status";

/** 命名密钥格式 */
export interface NamedApiKey {
  name: string;
  key: string;
}

/** 每个平台独立的轮询计数器（内存态，重启归零） */
const counters = new Map<string, number>();

/**
 * 平台 apiKeys JSON 读改写互斥锁（进程内串行化「读整表 → 修改 → 写整表」）
 *
 * 与 src/lib/upstream-proxy.ts withHealthLock 同模式：并发 recordKeyError/
 * enableKey 对同一平台 apiKeys JSON 整表覆盖时，后写者基于锁内重读的最新
 * 已落库状态合并，避免 TiDB 行锁竞争（Error 1205）与并发覆盖丢失写入。
 * 锁为进程内互斥（Docker 单实例即完备）：锁内执行体不得再等待本锁
 * （会确定性死锁）；多实例部署需外部互斥。
 */
let keyWriteTail: Promise<unknown> = Promise.resolve();

// ==================== Key 白名单机制 ====================

/** 白名单 Key 集合（内存态，可通过 D1 加载） */
const whitelistedKeys = new Set<string>();

/** 白名单 Key 降级冷却（收到429时不封禁，但临时降低优先级） */
const whitelistedKeyCooldowns = new Map<string, number>();

const WHITELISTED_KEY_COOLDOWN_MS = 2 * 60 * 1000; // 白名单 Key 降级 2 分钟

/** 白名单平台（永不封禁，密钥仍正常封禁） */
const whitelistedPlatforms = new Set<string>();

// ==================== 白名单 TTL 自动刷新（A2） ====================

/**
 * 白名单自动刷新间隔：管理后台勾选/取消「白名单」后最多 60s 在运行期生效，
 * 无需重启进程。刷新为后台触发（isKeyWhitelisted/isPlatformWhitelisted 是
 * 同步函数，无法阻塞等待），本次调用继续用旧集合，刷新完成后后续调用生效。
 */
const WHITELIST_REFRESH_MS = 60 * 1000;

/** 白名单上次成功加载时间（0 = 从未成功加载，首载由入口懒加载负责） */
let whitelistLastLoadedAt = 0;

/** 白名单后台刷新单飞 promise（进行中复用，防并发请求重复加载） */
let whitelistReloadPromise: Promise<boolean> | null = null;

/** 最近一次 loadWhitelist 的调用参数（TTL 到期后复用同一数据源重新加载） */
let whitelistLoader: { db: D1Database; env?: WorkerEnv } | null = null;

/**
 * 加载白名单（从所有平台的 apiKeys JSON 中读取 whitelisted 标记）
 *
 * 返回是否加载成功：失败时保留旧集合继续用（调用方据此决定是否重试，
 * 如入口懒加载标志只在成功后置位）。幂等：重复并发加载清空重建，无害。
 */
export async function loadWhitelist(db: D1Database, env?: WorkerEnv): Promise<boolean> {
  // 记住加载参数：TTL 到期后的后台刷新复用同一数据源（dummyDb 等引用
  // 由调用方模块级变量维护，此处缓存的是最新引用）
  whitelistLoader = { db, env };
  try {
    const { createDb } = await import("@/lib/prisma");
    const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
    const platforms = await prisma.platforms.findMany({
      select: { id: true, apiKeys: true, whitelisted: true },
    });
    whitelistedPlatforms.clear();
    whitelistedKeys.clear();
    for (const p of platforms) {
      // M-eM-^NM-^FM-eM-^OM-2M-fM-^UM-0M-fM-^MM-.M-fM--M-#M-gM-^YM-=M-eM-^PM-^MM-eM-^MM-^UM-dM-8M--
      if (p.whitelisted === true) {
        whitelistedPlatforms.add(p.id);
      }
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
    whitelistLastLoadedAt = Date.now();
    console.log(`[platform-keys] 已加载 ${whitelistedPlatforms.size} 个白名单平台，${whitelistedKeys.size} 个白名单 Key`);
    return true;
  } catch (err) {
    console.error("[platform-keys] 加载白名单失败:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * 白名单 TTL 自动刷新（A2）：集合上次成功加载超过 60s 后，下一次
 * isKeyWhitelisted/isPlatformWhitelisted 调用触发后台重新加载，
 * 使管理后台修改「白名单」在运行期生效。
 *
 * - 单飞：进行中复用同一 promise，避免并发请求重复加载
 * - 失败保留旧集合继续用（loadWhitelist 内部 catch 返回 false，不抛错），
 *   且不更新 lastLoadedAt，下次调用会再次尝试
 * - 从未成功加载（lastLoadedAt === 0）时不触发：首载由各入口懒加载负责
 */
function maybeRefreshWhitelist(): void {
  if (whitelistLastLoadedAt === 0) return;
  if (Date.now() - whitelistLastLoadedAt <= WHITELIST_REFRESH_MS) return;
  if (whitelistReloadPromise || !whitelistLoader) return;
  whitelistReloadPromise = loadWhitelist(whitelistLoader.db, whitelistLoader.env).finally(() => {
    whitelistReloadPromise = null;
  });
}

/**
 * 检查 Key 是否在白名单中（调用前先触发 TTL 过期检查，后台刷新）
 */
export function isKeyWhitelisted(key: string): boolean {
  maybeRefreshWhitelist();
  return whitelistedKeys.has(key);
}

// ==================== Key 封禁机制（429 专用） ====================

/**
 * Key 封禁到期时间戳（内存态，重启归零）
 *
 * 键为 `platformId:keyFingerprint` 复合键：同一密钥字符串配置在多个平台时，
 * 某个平台收到 429 封禁不应连坐其它平台。
 *
 * 已知限制：Worker 冷启动后封禁状态丢失，被封禁的 Key 可能立即恢复使用。
 * 这是 Cloudflare Workers 无状态架构的固有限制。
 * 如需持久化封禁状态，可使用 KV 存储（增加一次网络往返）。
 */
const keyCooldowns = new Map<string, number>();

const DEFAULT_KEY_BAN_MS = 5 * 60 * 1000;

/**
 * 持久化禁用的密钥集合（内存态）
 *
 * 错误计数达阈值后自动禁用，加入此集合。
 * 用户手动启用后从此集合移除。
 * 与 keyCooldowns 不同：keyCooldowns 有过期时间（5分钟自动恢复），
 * disabledKeys 无过期，只能手动启用恢复。
 */
const disabledKeys = new Set<string>();

/** 平台维度封禁键：`platformId:keyFingerprint`（platformId 为空时兼容无平台调用） */
function banKeyId(platformId: string | undefined, key: string): string {
  return `${platformId ?? ""}:${keyFingerprint(key)}`;
}

/**
 * 封禁指定 Key（收到429时调用）
 * 白名单 Key 或白名单平台的 Key 不会被封禁，只会被临时降级
 *
 * 状态同时写入 KV（按平台维度持久化），供管理后台展示实时密钥状态；
 * 内存 Map 为快速判断层，冷启动后通过 loadKeyStatusFromKV 从 KV 恢复。
 */
export async function banKey(
  key: string,
  durationMs: number = DEFAULT_KEY_BAN_MS,
  platformId?: string,
  kv?: KVNamespace
): Promise<void> {
  const fp = keyFingerprint(key);

  // 白名单平台或白名单 Key：不封禁，只降级（降级同样按平台维度隔离）
  if (isPlatformWhitelisted(platformId) || isKeyWhitelisted(key)) {
    const expireAt = Date.now() + WHITELISTED_KEY_COOLDOWN_MS;
    whitelistedKeyCooldowns.set(banKeyId(platformId, key), expireAt);
    if (platformId && kv) {
      await writePlatformKeyStatus(kv, platformId, fp, { status: "deprioritized", expireAt });
    }
    return;
  }

  const expireAt = Date.now() + durationMs;
  keyCooldowns.set(banKeyId(platformId, key), expireAt);
  if (platformId && kv) {
    await writePlatformKeyStatus(kv, platformId, fp, { status: "banned", expireAt });
  }
}

/**
 * 检查 Key 是否处于封禁状态（白名单平台或白名单 Key 永远不会被封禁）
 *
 * @param platformId - 封禁所属平台（同一密钥字符串在不同平台不互相连坐）
 */
export function isKeyBanned(key: string, platformId?: string): boolean {
  if (isPlatformWhitelisted(platformId) || isKeyWhitelisted(key)) return false;

  const expireAt = keyCooldowns.get(banKeyId(platformId, key));
  if (!expireAt) return false;
  if (Date.now() >= expireAt) {
    keyCooldowns.delete(banKeyId(platformId, key));
    return false;
  }
  return true;
}

/**
 * 检查 Key 是否处于降级状态（白名单 Key 收到429后临时降低优先级）
 */
export function isKeyDeprioritized(key: string, platformId?: string): boolean {
  const expireAt = whitelistedKeyCooldowns.get(banKeyId(platformId, key));
  if (!expireAt) return false;
  if (Date.now() >= expireAt) {
    whitelistedKeyCooldowns.delete(banKeyId(platformId, key));
    return false;
  }
  return true;
}

/**
 * 检查平台是否为白名单平台（永不封禁，密钥仍正常封禁）
 */
export function isPlatformWhitelisted(platformId?: string): boolean {
  maybeRefreshWhitelist();
  if (!platformId) return false;
  return whitelistedPlatforms.has(platformId);
}

/**
 * 从 KV 恢复 Key 封禁/降级状态到内存（冷启动后调用）
 *
 * KV 中只存密钥指纹，需要结合平台密钥明文计算指纹后才能映射回内存 Map。
 * 无 KV（非 Cloudflare 部署）时仍恢复持久化禁用集合（DB enabled=false），
 * 否则进程重启后自动禁用的密钥会复活且不再累计错误。
 *
 * 返回是否加载成功：失败时保留已有内存状态（入口懒加载标志只在成功后
 * 置位，下次请求重试）。
 */
export async function loadKeyStatusFromKV(
  db: D1Database,
  kv: KVNamespace | undefined,
  env?: WorkerEnv
): Promise<boolean> {
  try {
    const { createDb } = await import("@/lib/prisma");
    const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
    const platforms = await prisma.platforms.findMany({
      select: { id: true, apiKeys: true },
    });

    if (!kv) {
      // 无 KV：仅从 DB 恢复持久化禁用的密钥（错误计数达阈值自动禁用）
      let loaded = 0;
      for (const p of platforms) {
        for (const ko of parseApiKeyObjects(p.apiKeys)) {
          if (ko.enabled === false) {
            disabledKeys.add(banKeyId(p.id, ko.key));
            loaded++;
          }
        }
      }
      if (loaded > 0) {
        console.log(`[platform-keys] 已从数据库恢复 ${loaded} 个持久化禁用 Key（无 KV）`);
      }
      return true;
    }

    let loaded = 0;
    for (const p of platforms) {
      const statuses = await readPlatformKeyStatus(kv, p.id);
      if (Object.keys(statuses).length === 0) {
        // 即使无 KV 状态也要加载持久化禁用的密钥
        const keyObjects = parseApiKeyObjects(p.apiKeys);
        for (const ko of keyObjects) {
          if (ko.enabled === false) {
            disabledKeys.add(banKeyId(p.id, ko.key));
            loaded++;
          }
        }
        continue;
      }

      const keys = getAllKeys({
        id: p.id,
        apiKeys: parseApiKeys(p.apiKeys),
      } as PlatformConfig);

      for (const k of keys) {
        const st = statuses[keyFingerprint(k)];
        if (!st) continue;
        if (st.status === "banned") {
          keyCooldowns.set(banKeyId(p.id, k), st.expireAt);
        } else {
          whitelistedKeyCooldowns.set(banKeyId(p.id, k), st.expireAt);
        }
        loaded++;
      }

      // 同时加载持久化禁用的密钥
      const keyObjects = parseApiKeyObjects(p.apiKeys);
      for (const ko of keyObjects) {
        if (ko.enabled === false) {
          disabledKeys.add(banKeyId(p.id, ko.key));
        }
      }
    }

    if (loaded > 0) {
      console.log(`[platform-keys] 已从 KV 恢复 ${loaded} 个 Key 状态`);
    }
    return true;
  } catch (err) {
    console.error("[platform-keys] 从 KV 加载 Key 状态失败:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * 获取平台全部可用密钥（去空值、去重）
 */
export function getAllKeys(platform: PlatformConfig): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const k of platform.apiKeys) {
    if (typeof k === "string" && k.trim().length > 0 && !seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return keys;
}

/**
 * 获取平台持久化禁用（DB enabled=false）的密钥集合
 *
 * 内存 disabledKeys 仅靠冷启动 loadKeyStatusFromKV 恢复，进程重启后可能为空；
 * DB 的 enabled 字段是权威状态，选择时必须直接过滤，防止被禁用的密钥复活。
 */
function getDisabledKeysFromDb(platform: PlatformConfig): Set<string> {
  const set = new Set<string>();
  for (const ko of platform.apiKeyObjects ?? []) {
    if (ko.enabled === false) set.add(ko.key);
  }
  return set;
}

/**
 * Round-robin 获取下一个密钥
 *
 * 优先级：非白名单正常 Key > 白名单正常 Key > 白名单降级 Key
 * 跳过已封禁、已禁用（DB enabled=false）的 Key。如果平台没有可用密钥，返回 null。
 */
export function getNextKey(platform: PlatformConfig): string | null {
  const allKeys = getAllKeys(platform);
  if (allKeys.length === 0) return null;

  const counter = counters.get(platform.id) ?? 0;
  const dbDisabled = getDisabledKeysFromDb(platform);

  // 优先级1：非白名单、未封禁、未降级、未持久化禁用的 Key
  for (let i = 0; i < allKeys.length; i++) {
    const index = (counter + i) % allKeys.length;
    const key = allKeys[index];
    if (
      !isKeyWhitelisted(key) &&
      !isKeyBanned(key, platform.id) &&
      !isKeyDeprioritized(key, platform.id) &&
      !isKeyDisabled(key, platform.id) &&
      !dbDisabled.has(key)
    ) {
      counters.set(platform.id, counter + i + 1);
      return key;
    }
  }

  // 优先级2：白名单（平台或 Key）中未降级、未持久化禁用的 Key
  for (let i = 0; i < allKeys.length; i++) {
    const index = (counter + i) % allKeys.length;
    const key = allKeys[index];
    if (
      (isPlatformWhitelisted(platform.id) || isKeyWhitelisted(key)) &&
      !isKeyDeprioritized(key, platform.id) &&
      !isKeyDisabled(key, platform.id) &&
      !dbDisabled.has(key)
    ) {
      counters.set(platform.id, counter + i + 1);
      return key;
    }
  }

  // 优先级3：白名单（平台或 Key）中已降级但未持久化禁用的 Key（最后手段）
  for (let i = 0; i < allKeys.length; i++) {
    const index = (counter + i) % allKeys.length;
    const key = allKeys[index];
    if (
      (isPlatformWhitelisted(platform.id) || isKeyWhitelisted(key)) &&
      isKeyDeprioritized(key, platform.id) &&
      !isKeyDisabled(key, platform.id) &&
      !dbDisabled.has(key)
    ) {
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
 * 排除已尝试过、已封禁、已禁用（DB enabled=false）的密钥。
 */
export function getRandomKeyExcept(
  platform: PlatformConfig,
  excludeKeys: Set<string>
): string | null {
  const allKeys = getAllKeys(platform);
  const dbDisabled = getDisabledKeysFromDb(platform);
  const usable = (k: string) =>
    !excludeKeys.has(k) &&
    !isKeyDisabled(k, platform.id) &&
    !dbDisabled.has(k);

  // 优先级1：非白名单、未封禁、未降级
  const tier1 = allKeys.filter(
    (k) => usable(k) && !isKeyWhitelisted(k) && !isKeyBanned(k, platform.id) && !isKeyDeprioritized(k, platform.id)
  );
  if (tier1.length > 0) return tier1[Math.floor(Math.random() * tier1.length)];

  // 优先级2：白名单（平台或 Key）中未降级
  const tier2 = allKeys.filter(
    (k) => usable(k) && (isPlatformWhitelisted(platform.id) || isKeyWhitelisted(k)) && !isKeyDeprioritized(k, platform.id)
  );
  if (tier2.length > 0) return tier2[Math.floor(Math.random() * tier2.length)];

  // 优先级3：白名单（平台或 Key）中已降级
  const tier3 = allKeys.filter(
    (k) => usable(k) && (isPlatformWhitelisted(platform.id) || isKeyWhitelisted(k)) && isKeyDeprioritized(k, platform.id)
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
          .map((k) => k.key.trim());
      }
      // 旧格式：字符串数组 ["key1", "key2"]
      return parsed
        .filter(
          (k): k is string => typeof k === "string" && k.trim().length > 0
        )
        .map((k) => k.trim());
    }
  } catch {
    // JSON 解析失败，忽略
  }
  return [];
}

/**
 * 解析 apiKeys JSON 字符串为密钥对象数组（含 enabled/errorCount 等元数据）
 */
export function parseApiKeyObjects(raw: string | null | undefined): PlatformApiKeyObject[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (k): k is Record<string, unknown> =>
          typeof k === "object" && k !== null && typeof k.key === "string" && (k.key as string).trim().length > 0
      )
      .map((k) => ({
        name: typeof k.name === "string" ? k.name : "Key",
        key: (k.key as string).trim(),
        whitelisted: k.whitelisted === true,
        enabled: k.enabled !== false,
        errorCount: typeof k.errorCount === "number" ? k.errorCount : 0,
      }));
  } catch {
    return [];
  }
}

// ==================== 密钥错误计数与自动禁用 ====================

/** 错误计数阈值：达到此值后自动禁用密钥 */
const KEY_ERROR_THRESHOLD = 5;

/**
 * 根据上游错误状态码计算错误计数增量
 *
 * 429 算 1 次，401 算 2 次，402（Payment Required）算 5 次（一次即达阈值立即禁用），
 * 其余可重试错误（403/空响应等）算 1 次
 */
function errorIncrement(status: number): number {
  if (status === 402) return 5;
  if (status === 401) return 2;
  if (status === 429) return 1;
  return 1;
}

/**
 * 记录密钥错误并更新数据库中的 errorCount
 *
 * - 累加错误计数（429→+1, 401→+2, 402→+5 一次即达阈值禁用, 其余→+1）
 * - 达到 5 次后自动将密钥 enabled 设为 false，不再变更 errorCount
 * - 已禁用的密钥再次调用不会变更 errorCount
 * - 白名单 Key 或白名单平台的密钥豁免：不累计错误计数、不自动禁用，仅临时降级（与 banKey 语义一致）
 *
 * 同时写入内存禁用集合，保证即时生效（下一次密钥选择立即跳过）
 */
export async function recordKeyError(
  key: string,
  upstreamStatus: number,
  platformId: string,
  db: D1Database,
  env?: WorkerEnv
): Promise<void> {
  try {
    const run = async (): Promise<void> => {
      const { createDb } = await import("@/lib/prisma");
      const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
      // 锁内重读：拿到最新已落库的 apiKeys，基于它合并计数（后写者不覆盖并发写入）
      const platform = await prisma.platforms.findFirst({
        where: { id: platformId },
        select: { apiKeys: true },
      });
      if (!platform?.apiKeys) return;

      const keys = parseApiKeyObjects(platform.apiKeys);
      const target = keys.find((k) => k.key === key);
      if (!target) return;

      // 白名单 Key 或白名单平台：不累计错误计数、不自动禁用，仅临时降级（同 banKey）
      if (isPlatformWhitelisted(platformId) || isKeyWhitelisted(key)) {
        const expireAt = Date.now() + WHITELISTED_KEY_COOLDOWN_MS;
        whitelistedKeyCooldowns.set(banKeyId(platformId, key), expireAt);
        console.log(
          `[platform-keys] 白名单密钥 ${keyFingerprint(key)} 收到上游错误 ${upstreamStatus}，仅降级不计数（平台 ${platformId}）`
        );
        return;
      }

      // 已禁用的密钥不再变更错误计数
      if (target.enabled === false) return;

      const increment = errorIncrement(upstreamStatus);
      const newCount = (target.errorCount ?? 0) + increment;

      if (newCount >= KEY_ERROR_THRESHOLD) {
        target.enabled = false;
        target.errorCount = newCount;
      } else {
        target.errorCount = newCount;
      }

      // 更新整个 apiKeys JSON 字段
      const updatedJson = JSON.stringify(keys.map((k) => {
        const obj: Record<string, unknown> = { name: k.name, key: k.key };
        if (k.whitelisted) obj.whitelisted = true;
        if (k.enabled === false) obj.enabled = false;
        if (k.errorCount && k.errorCount > 0) obj.errorCount = k.errorCount;
        return obj;
      }));

      await prisma.platforms.update({
        where: { id: platformId },
        data: { apiKeys: updatedJson, updatedAt: Math.floor(Date.now() / 1000) },
      });

      // 内存层即时禁用
      if (target.enabled === false) {
        disabledKeys.add(banKeyId(platformId, key));
        console.log(
          `[platform-keys] 密钥 ${keyFingerprint(key)} 错误计数达 ${newCount}，已自动禁用（平台 ${platformId}）`
        );
      } else {
        console.log(
          `[platform-keys] 密钥 ${keyFingerprint(key)} 错误计数 ${newCount}/${KEY_ERROR_THRESHOLD}（平台 ${platformId}）`
        );
      }
    };
    const p = keyWriteTail.then(run, run);
    keyWriteTail = p.catch(() => undefined);
    await p;
  } catch (err) {
    console.error(
      `[platform-keys] 记录密钥错误失败:`,
      (err instanceof Error ? err.message : String(err)).substring(0, 200)
    );
  }
}

/**
 * 手动启用密钥：DB 清零 + 内存禁用/冷却清理 + KV 残留删除（统一实现）
 *
 * - DB：enabled=true、errorCount=0（锁内重读，与 recordKeyError 共用 keyWriteTail 串行锁）
 * - 内存：清除 disabledKeys 与 429 临时封禁/降级冷却（keyCooldowns/whitelistedKeyCooldowns），
 *   立即生效，无需等冷却自然到期
 * - KV：删除持久化残留（banned 无 TTL，冷启动 loadKeyStatusFromKV 会恢复继续封禁）
 *
 * db 可省略（Pages 管理端无 D1 binding 时走 createDb 自动检测）；
 * kv 可省略（非 Cloudflare 部署无 KV binding）。
 */
export async function enableKey(
  key: string,
  platformId: string,
  db?: D1Database,
  kv?: KVNamespace,
  dbType?: string
): Promise<void> {
  try {
    const run = async (): Promise<void> => {
      const { createDb } = await import("@/lib/prisma");
      const prisma = await createDb(
        db ? { DB: db, DB_TYPE: dbType ?? process.env.DB_TYPE } : undefined
      );
      // 锁内重读：基于最新已落库状态清零（与 recordKeyError 共用同一把锁）
      const platform = await prisma.platforms.findFirst({
        where: { id: platformId },
        select: { apiKeys: true },
      });
      if (!platform?.apiKeys) {
        throw new Error(`平台不存在或无 apiKeys 配置（platformId: ${platformId}）`);
      }

      const keys = parseApiKeyObjects(platform.apiKeys);
      const target = keys.find((k) => k.key === key);
      if (!target) {
        throw new Error(`密钥不存在于平台配置中（platformId: ${platformId}）`);
      }

      target.enabled = true;
      target.errorCount = 0;

      const updatedJson = JSON.stringify(keys.map((k) => {
        const obj: Record<string, unknown> = { name: k.name, key: k.key };
        if (k.whitelisted) obj.whitelisted = true;
        if (k.enabled === false) obj.enabled = false;
        if (k.errorCount && k.errorCount > 0) obj.errorCount = k.errorCount;
        return obj;
      }));

      await prisma.platforms.update({
        where: { id: platformId },
        data: { apiKeys: updatedJson, updatedAt: Math.floor(Date.now() / 1000) },
      });

      // 清除内存禁用标记与 429 临时封禁/降级冷却（立即生效）
      clearKeyDisabled(key, platformId);
      clearKeyCooldown(key, platformId);
      // 删除 KV 持久化残留（无 TTL，冷启动会恢复继续封禁）
      if (kv) await removePlatformKeyStatus(kv, platformId, keyFingerprint(key));

      console.log(`[platform-keys] 密钥 ${keyFingerprint(key)} 已手动启用，错误计数清零（平台 ${platformId}）`);
    };
    const p = keyWriteTail.then(run, run);
    keyWriteTail = p.catch(() => undefined);
    await p;
  } catch (err) {
    // 必须上抛：管理端 PATCH 依赖失败信号返回非 200，
    // 吞掉会让调用方误报"密钥已启用"假成功
    console.error(
      `[platform-keys] 启用密钥失败:`,
      (err instanceof Error ? err.message : String(err)).substring(0, 200)
    );
    throw err;
  }
}

/** 检查密钥是否已被持久化禁用（错误计数达阈值） */
export function isKeyDisabled(key: string, platformId?: string): boolean {
  return disabledKeys.has(banKeyId(platformId, key));
}

/**
 * 清除密钥的持久化禁用标记（仅内存层，不操作数据库）
 *
 * 管理后台路由直接操作数据库 JSON 字段后调用此函数同步内存状态。
 */
export function clearKeyDisabled(key: string, platformId: string): void {
  disabledKeys.delete(banKeyId(platformId, key));
}

/**
 * 清除密钥的 429 临时封禁/降级冷却（仅内存层，不操作 KV）
 *
 * 手动启用密钥时必须调用：只清 disabledKeys 不清 keyCooldowns 的话，
 * 密钥仍被 isKeyBanned 拦截到冷却自然到期（最多 5 分钟）。
 */
export function clearKeyCooldown(key: string, platformId: string): void {
  keyCooldowns.delete(banKeyId(platformId, key));
  whitelistedKeyCooldowns.delete(banKeyId(platformId, key));
}

/**
 * 标记密钥为持久化禁用（仅内存层，不操作数据库）
 *
 * 管理后台路由直接操作数据库 JSON 字段后调用此函数同步内存状态。
 */
export function markKeyDisabled(key: string, platformId: string): void {
  disabledKeys.add(banKeyId(platformId, key));
}

/**
 * 从进程内存态构造平台 Key 状态（管理后台同进程读取用）
 *
 * Docker/EdgeOne 等非 Cloudflare 部署下 pages/api/admin 与 v1 路由同 Node
 * 进程，模块级 keyCooldowns/whitelistedKeyCooldowns 共享，直接读取即可
 * 反映 429 封禁/降级的实时状态；Cloudflare 部署下 admin 进程无内存态
 * （返回空），由 KV 路径（readPlatformKeyStatus）提供状态。
 * 键为密钥指纹，与 KV 持久化格式一致，前端可统一按指纹消费。
 */
export function getKeyStatusesFromMemory(
  platformId: string,
  keys: string[]
): PlatformKeyStatus {
  const result: PlatformKeyStatus = {};
  const now = Date.now();
  for (const key of keys) {
    if (typeof key !== "string" || key.trim().length === 0) continue;
    const fp = keyFingerprint(key);
    const bannedEnd = keyCooldowns.get(banKeyId(platformId, key));
    if (bannedEnd !== undefined && bannedEnd > now) {
      result[fp] = { status: "banned", expireAt: bannedEnd };
      continue;
    }
    const deprioritizedEnd = whitelistedKeyCooldowns.get(banKeyId(platformId, key));
    if (deprioritizedEnd !== undefined && deprioritizedEnd > now) {
      result[fp] = { status: "deprioritized", expireAt: deprioritizedEnd };
    }
  }
  return result;
}
