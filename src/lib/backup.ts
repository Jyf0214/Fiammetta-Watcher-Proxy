/**
 * 定时备份任务
 *
 * 构建系统级配置快照（平台/配置/API Keys）→ AES-GCM 加密 →
 * POST 到接收端。
 *
 * 接收端来源（按优先级）：
 * 1. 管理后台通知配置 channels 中 type === "backup" 且 enabled === true 的多条
 *    （支持多接收端串行推送，每条独立重试；任一成功即视为整体成功）
 * 2. 兜底：环境变量 BACKUP_WEBHOOK_URL / BACKUP_ENCRYPTION_KEY（单接收端 v1 兼容）
 *
 * 加密信封格式（kdf 字段区分）：
 * - v1: { encrypted: true, alg: "AES-GCM-256", iv, data }
 *      密钥派生 = SHA-256(secret)；接收端若用 env 派生可继续解密
 * - v2: { encrypted: true, alg: "AES-GCM-256", kdf: "pbkdf2-sha256",
 *         iter: 100000, salt, iv, data }
 *      密钥派生 = PBKDF2(SHA-256, secret, iter, 32)；管理后台通道用
 *
 * 安全门控（强制）：
 * - 快照含上游平台与 API Keys 明文密钥，未配置任何加密钥时
 *   **拒绝推送**（返回 skipped），绝不以明文离开本机；
 * - 多接收端串行推送：每接收端独立重试，最后一次失败才写 history=failed
 * - 所有接收端均失败：触发 backup_failed 事件走普通通知通道（旁路）
 *
 * 双端注册：pages/api/cron/[[...cron]].ts 映射 + worker scheduled case，
 * CRON_SECRET 认证由 cron 路由统一处理。
 */

import { buildConfigBackup, bigintReplacer } from "@/lib/backup-builder";
import { createDb, type Database } from "@/lib/prisma";
import {
  parseNotificationsConfig,
  type NotificationChannel,
} from "./notifier";
import { recordHistory } from "./notification-store";
import { sendNotification } from "./notifier";
import { isSafeUpstreamUrl } from "./ssrf";

export interface BackupTaskResult {
  success: boolean;
  /** skipped 原因（未配加密钥/未配推送端等）；pushed 时为空 */
  skipped?: string;
  pushed?: boolean;
  /** 实际推送的接收端数（多接收端时 > 1） */
  pushedCount?: number;
  /** 失败的接收端数（多接收端时） */
  failedCount?: number;
  sizeBytes?: number;
  durationMs?: number;
}

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LENGTH_BITS = 256;
const BACKUP_TIMEOUT_MS = 30_000;
const BACKUP_MAX_RETRIES = 2; // 总尝试 = 1 + 2 = 3 次
const BACKUP_RETRY_BACKOFF_MS = [1_000, 2_000];

/** 测试钩子：替换 sleep 缩短测试时长 */
let sleepImpl: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export function _setBackupSleepForTests(fn: (ms: number) => Promise<void>): void {
  sleepImpl = fn;
}
const sleep = (ms: number): Promise<void> => sleepImpl(ms);

/** 派生 v1 信封密钥：SHA-256(secret) — 兼容旧 env 接收端 */
async function deriveKeyV1(secret: string): Promise<CryptoKey> {
  // crypto.subtle.digest 返回 ArrayBuffer 直接满足 BufferSource
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt"]);
}

/** 派生 v2 信封密钥：PBKDF2(SHA-256, secret, iter, 32B) */
async function deriveKeyV2(
  secret: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  // Node 24 + TS 5.7+ 对 Uint8Array<ArrayBufferLike> 推断为非 ArrayBuffer
  // 子类型，需显式 ArrayBuffer 转换
  const secretBytes = new TextEncoder().encode(secret);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    secretBytes.buffer.slice(
      secretBytes.byteOffset,
      secretBytes.byteOffset + secretBytes.byteLength
    ) as ArrayBuffer,
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations },
    baseKey,
    { name: "AES-GCM", length: PBKDF2_KEY_LENGTH_BITS },
    false,
    ["encrypt"]
  );
}

/** Uint8Array → base64（分块拼接避免大数组 spread 爆栈；Node/Workers 均可用 btoa） */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** v1 信封：AES-GCM + SHA-256 派生（兼容旧接收端） */
async function encryptBackupV1(plain: string, secret: string): Promise<string> {
  const key = await deriveKeyV1(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain)
  );
  return JSON.stringify({
    encrypted: true,
    alg: "AES-GCM-256",
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(ciphertext)),
  });
}

/** v2 信封：AES-GCM + PBKDF2 派生（管理后台通道使用） */
async function encryptBackupV2(
  plain: string,
  secret: string,
  iterations: number = PBKDF2_ITERATIONS
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKeyV2(secret, salt, iterations);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain)
  );
  return JSON.stringify({
    encrypted: true,
    alg: "AES-GCM-256",
    kdf: "pbkdf2-sha256",
    iter: iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(ciphertext)),
  });
}

/** 读取通知配置中的 backup 通道列表（管理后台配置） */
async function loadBackupChannels(): Promise<NotificationChannel[]> {
  try {
    const db = await createDb();
    const row = await db.configs.findFirst({
      where: { key: "system:notifications" },
      select: { value: true },
    });
    if (!row?.value) return [];
    const config = parseNotificationsConfig(row.value);
    return config.channels.filter((c) => c.type === "backup" && c.enabled);
  } catch (err) {
    console.error(
      "[backup] 读取通知配置失败:",
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

/**
 * 推送加密备份到单接收端
 *
 * @returns true = 成功；false = 全部重试均失败
 */
async function pushToOneReceiver(
  url: string,
  encrypted: string,
  channelId: string,
  channelName: string,
  sizeBytes: number
): Promise<{ ok: boolean; httpStatus: number | null; error: string | null; durationMs: number }> {
  const start = Date.now();
  let lastHttpStatus: number | null = null;
  let lastError: string | null = null;
  for (let attempt = 0; attempt <= BACKUP_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BACKUP_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "FWP-Backup/2.0",
        },
        body: encrypted,
        signal: controller.signal,
      });
      if (typeof res.arrayBuffer === "function") {
        try {
          await res.arrayBuffer();
        } catch {
          await res.body?.cancel().catch(() => {});
        }
      }
      lastHttpStatus = res.status;
      if (res.ok) {
        return { ok: true, httpStatus: res.status, error: null, durationMs: Date.now() - start };
      }
      lastError = `HTTP ${res.status}`;
      if (attempt === BACKUP_MAX_RETRIES) break;
      console.error(
        `[backup] 接收端 ${url} 第 ${attempt + 1} 次返回 HTTP ${res.status}，准备重试`
      );
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === BACKUP_MAX_RETRIES) {
        console.error(
          `[backup] 接收端 ${url} 重试 ${BACKUP_MAX_RETRIES} 次后仍失败: ${lastError}`
        );
        break;
      }
      console.error(
        `[backup] 接收端 ${url} 第 ${attempt + 1} 次失败: ${lastError}，准备重试`
      );
    } finally {
      clearTimeout(timer);
    }
    if (attempt < BACKUP_MAX_RETRIES) {
      await sleep(BACKUP_RETRY_BACKOFF_MS[attempt]);
    }
  }
  // 写发送历史（旁路，失败不阻塞）
  const db = await createDb();
  await recordHistory({
    channelId,
    channelName,
    channelType: "backup",
    event: "backup_push",
    title: "加密备份推送",
    body: `推送至 ${url}`,
    status: "failed",
    httpStatus: lastHttpStatus,
    error: lastError,
    sizeBytes,
    durationMs: Date.now() - start,
  }).catch(() => {});
  return { ok: false, httpStatus: lastHttpStatus, error: lastError, durationMs: Date.now() - start };
}

/**
 * 执行一次备份任务
 *
 * @param db 数据库绑定/客户端
 * @param envObj 环境变量来源（Worker env 或 Node process.env 形状，
 *   仅读取 BACKUP_ENCRYPTION_KEY / BACKUP_WEBHOOK_URL 两个键作兜底）
 */
export async function runBackupTask(
  db: D1Database | Database,
  envObj?: Record<string, unknown>
): Promise<BackupTaskResult> {
  // 来源 1：管理后台 backup 通道列表
  const backupChannels = await loadBackupChannels();
  // 来源 2：env 变量兜底（v1 信封 + 单接收端）
  const envEncryptionKey =
    (typeof envObj?.BACKUP_ENCRYPTION_KEY === "string" && envObj.BACKUP_ENCRYPTION_KEY) ||
    process.env.BACKUP_ENCRYPTION_KEY;
  const envWebhookUrl =
    (typeof envObj?.BACKUP_WEBHOOK_URL === "string" && envObj.BACKUP_WEBHOOK_URL) ||
    process.env.BACKUP_WEBHOOK_URL;

  // 收集有效接收端
  interface Receiver {
    url: string;
    secret: string;
    channelId: string;
    channelName: string;
    useV2: boolean; // true = PBKDF2 信封；false = v1 SHA-256 信封
  }
  const receivers: Receiver[] = [];

  for (const ch of backupChannels) {
    if (!/^https?:\/\//i.test(ch.url)) {
      console.error(`[backup] 通道 ${ch.name} URL 非法，跳过: ${ch.url}`);
      continue;
    }
    // SSRF 二次防御：parse 阶段已挡一次（strict=true），但 admin 可绕过 API
    // 直接改 DB 注入内网 URL；这里也防止 enabled 的 backup 通道发向内网
    const ssrf = isSafeUpstreamUrl(ch.url);
    if (!ssrf.safe) {
      console.error(
        `[backup] 通道 ${ch.name} URL 内网或本地（${ssrf.reason ?? "不安全"}），跳过`
      );
      continue;
    }
    // backup 通道加密密钥：options.encryptionKey 优先，未填走 env 兜底
    const secret = ch.options.encryptionKey?.trim() || envEncryptionKey;
    if (!secret) {
      console.error(
        `[backup] 通道 ${ch.name} 未配置 encryptionKey 且 env BACKUP_ENCRYPTION_KEY 未设置，跳过`
      );
      continue;
    }
    receivers.push({
      url: ch.url,
      secret,
      channelId: ch.id,
      channelName: ch.name,
      useV2: !!ch.options.encryptionKey?.trim(), // 管理后台显式配置 → v2 信封
    });
  }
  // env 兜底：仅当管理后台未配置 backup 通道时使用
  if (receivers.length === 0 && envWebhookUrl) {
    if (!/^https?:\/\//i.test(envWebhookUrl)) {
      return { success: false, skipped: "BACKUP_WEBHOOK_URL 必须是 http(s) 地址" };
    }
    // env 兜底也走 SSRF 防御：环境变量里填内网地址拒绝推送
    const envSsrf = isSafeUpstreamUrl(envWebhookUrl);
    if (!envSsrf.safe) {
      return {
        success: false,
        skipped: `BACKUP_WEBHOOK_URL 内网或本地（${envSsrf.reason ?? "不安全"}）`,
      };
    }
    if (!envEncryptionKey) {
      return {
        success: false,
        skipped: "未配置 BACKUP_ENCRYPTION_KEY，拒绝明文外发备份",
      };
    }
    receivers.push({
      url: envWebhookUrl,
      secret: envEncryptionKey,
      channelId: "env-fallback",
      channelName: "BACKUP_WEBHOOK_URL (env)",
      useV2: false,
    });
  }

  if (receivers.length === 0) {
    return {
      success: true,
      pushed: false,
      skipped: "未配置 backup 通道或 BACKUP_WEBHOOK_URL，跳过备份推送",
    };
  }

  // 构建快照 + 加密（每次重新加密；多接收端各自独立 envelope）
  // IV/salt 必须唯一 → 同一 secret + 同一明文用不同 IV/salt 产生不同密文，
  // 故 envelope 不能跨接收端复用。PBKDF2 100k iter 单次 ~200ms 在
  // Cloudflare Worker CPU budget 内可接受（多接收端总成本仍 < 1s）
  const snapshot = await buildConfigBackup(db as never);
  const plain = JSON.stringify(snapshot, bigintReplacer);
  const totalStart = Date.now();
  let pushedCount = 0;
  let failedCount = 0;
  const sizeBytes = plain.length;

  for (const r of receivers) {
    // 每次重新加密（IV/salt 唯一性要求 envelope 不能复用）
    const envelope = r.useV2
      ? await encryptBackupV2(plain, r.secret)
      : await encryptBackupV1(plain, r.secret);
    const result = await pushToOneReceiver(r.url, envelope, r.channelId, r.channelName, envelope.length);
    if (result.ok) {
      pushedCount++;
      // 写成功 history
      const dbInstance = await createDb();
      await recordHistory({
        channelId: r.channelId,
        channelName: r.channelName,
        channelType: "backup",
        event: "backup_push",
        title: "加密备份推送",
        body: `推送至 ${r.url}`,
        status: "success",
        httpStatus: result.httpStatus,
        error: null,
        sizeBytes: envelope.length,
        durationMs: result.durationMs,
      }).catch(() => {});
    } else {
      failedCount++;
    }
  }

  const durationMs = Date.now() - totalStart;
  const overallOk = pushedCount > 0;

  if (!overallOk) {
    // 所有接收端都失败：触发 backup_failed 通知事件（旁路用其他通知通道）
    // URL mask：只保留 host，避免内部网络拓扑泄漏到第三方 IM
    const maskUrl = (u: string): string => {
      try {
        return new URL(u).host;
      } catch {
        return "<invalid-url>";
      }
    };
    const failedSummary = receivers
      .map((r) => {
        const urlPart = r.channelId === "env-fallback" ? "env" : maskUrl(r.url);
        return `${r.channelName}: ${urlPart}`;
      })
      .join("; ");
    try {
      void sendNotification(
        "backup_failed",
        "加密备份推送失败",
        `${failedCount}/${receivers.length} 个接收端推送失败（${failedSummary}）`,
        { db: db as Database }
      );
    } catch (err) {
      console.error(
        "[backup] 触发 backup_failed 通知异常:",
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return {
    success: overallOk,
    pushed: overallOk,
    pushedCount,
    failedCount,
    sizeBytes,
    durationMs,
  };
}
