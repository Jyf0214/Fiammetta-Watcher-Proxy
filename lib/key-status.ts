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
 * 已知限制：KV 无原子读改写，同一平台多个 Key 并发封禁时后写可能覆盖先写，
 * 丢失一个 Key 的持久化状态（内存封禁不受影响，仅影响冷启动恢复与后台展示）。
 */
export async function writePlatformKeyStatus(
  kv: KVNamespace,
  platformId: string,
  fp: string,
  value: KeyStatusValue
): Promise<void> {
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
}
