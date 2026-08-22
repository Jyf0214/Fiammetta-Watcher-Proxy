// ================================================================
// 上游 API Key 状态 — Worker 与 Pages 管理后台共享
//
// Key 封禁/降级状态由 Worker 在收到上游 429 时写入 KV（持久化），
// 管理后台通过读取 KV 展示每个平台密钥的实时状态。
// KV 值只存密钥指纹（fingerprint），不存明文 Key。
// ================================================================

/** 单个 Key 的状态值 */
export interface KeyStatusValue {
  status: "banned" | "deprioritized";
  /** 状态到期时间（毫秒时间戳），过期后视为正常 */
  expireAt: number;
}

/** 平台维度 Key 状态映射：fingerprint → 状态 */
export type PlatformKeyStatus = Record<string, KeyStatusValue>;

/** KV 键前缀：platform-key-status:<platformId> */
export const KEY_STATUS_PREFIX = "platform-key-status:";

/**
 * 计算 Key 指纹（日志/存储脱敏用，不可逆）
 *
 * 与历史日志脱敏实现保持同一算法，确保管理端能匹配 Worker 侧写入的状态。
 */
export function keyFingerprint(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

/** 构造平台 Key 状态的 KV 键 */
export function keyStatusKey(platformId: string): string {
  return `${KEY_STATUS_PREFIX}${platformId}`;
}

/**
 * KV 读改写串行队列（平台维度）
 *
 * Cloudflare KV 无原子 CAS，同一平台多 Key 并发封禁时读-改-写会互相覆盖。
 * 进程内按平台串行化，保证同一平台的多次写入基于最新已落库状态合并。
 * 多实例部署仍需外部互斥，但单实例 Worker 已能避免绝大多数丢失。
 */
const kvWriteTails = new Map<string, Promise<unknown>>();

function queueKvWrite<T>(platformId: string, fn: () => Promise<T>): Promise<T> {
  const tail = kvWriteTails.get(platformId) ?? Promise.resolve();
  const next = tail.then(fn, fn) as Promise<T>;
  // 捕获异常不阻断后续队列
  kvWriteTails.set(platformId, next.catch(() => {}));
  return next;
}

/**
 * 读取平台全部 Key 状态（自动过滤已过期项）
 */
export async function readPlatformKeyStatus(
  kv: KVNamespace,
  platformId: string
): Promise<PlatformKeyStatus> {
  try {
    const raw = await kv.get(keyStatusKey(platformId), { type: "text" });
    if (!raw) return {};

    const parsed = JSON.parse(raw) as PlatformKeyStatus;
    const now = Date.now();
    const result: PlatformKeyStatus = {};
    for (const [fp, value] of Object.entries(parsed)) {
      if (value && typeof value.expireAt === "number" && value.expireAt > now) {
        result[fp] = value;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * 写入单个 Key 的状态（读-改-写，保留其他 Key 的状态）
 *
 * 通过 queueKvWrite 串行化同一平台的并发写入，避免 KV 读-改-写竞态覆盖。
 * 多实例部署仍需外部互斥，但单实例 Worker 已能避免绝大多数丢失。
 */
export async function writePlatformKeyStatus(
  kv: KVNamespace,
  platformId: string,
  fp: string,
  value: KeyStatusValue
): Promise<void> {
  return queueKvWrite(platformId, async () => {
    try {
      const current = await readPlatformKeyStatus(kv, platformId);
      current[fp] = value;
      await kv.put(keyStatusKey(platformId), JSON.stringify(current));
    } catch (err) {
      console.error(
        `[key-status] 写入平台 ${platformId} Key 状态失败:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  });
}

/**
 * 删除单个 Key 的状态（读-改-写，保留其他 Key 的状态）
 *
 * 手动启用密钥时调用：banKey 写入的 banned 状态无 TTL，只写不删的话
 * 残留记录会在冷启动时被 loadKeyStatusFromKV 恢复，继续封禁该 Key。
 * 通过 queueKvWrite 串行化，与 writePlatformKeyStatus 对齐。
 */
export async function removePlatformKeyStatus(
  kv: KVNamespace,
  platformId: string,
  fp: string
): Promise<void> {
  return queueKvWrite(platformId, async () => {
    try {
      const current = await readPlatformKeyStatus(kv, platformId);
      if (!(fp in current)) return;
      delete current[fp];
      await kv.put(keyStatusKey(platformId), JSON.stringify(current));
    } catch (err) {
      console.error(
        `[key-status] 删除平台 ${platformId} Key 状态失败:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  });
}
