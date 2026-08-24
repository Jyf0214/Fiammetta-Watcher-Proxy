/**
 * 定时备份任务
 *
 * 构建系统级配置快照（平台/模型映射/配置/API Keys）→ AES-GCM 加密 →
 * POST 到 BACKUP_WEBHOOK_URL 指定的专用接收端。
 *
 * 安全门控（强制）：
 * - 快照含上游平台与 API Keys 明文密钥，未配置 BACKUP_ENCRYPTION_KEY 时
 *   **拒绝推送**（返回 skipped），绝不以明文离开本机；
 * - 推送目标使用独立的 BACKUP_WEBHOOK_URL 环境变量而非通知通道——
 *   Telegram/Bark 等 IM 通道有消息体积限制且会留存历史，不适合兆级
 *   加密负载；备份接收端应由用户自建（任意能收 POST 的 HTTP 服务）。
 *
 * 双端注册：pages/api/cron/[[...cron]].ts 映射 + worker scheduled case，
 * CRON_SECRET 认证由 cron 路由统一处理。
 */

import { buildConfigBackup, bigintReplacer } from "@/lib/backup-builder";
import type { Database } from "@/lib/prisma";

export interface BackupTaskResult {
  success: boolean;
  /** skipped 原因（未配加密钥/未配推送端等）；pushed 时为空 */
  skipped?: string;
  pushed?: boolean;
  sizeBytes?: number;
}

/** 加密密钥派生：对环境变量字符串取 SHA-256 得到 AES-256 主密钥 */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt"]);
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

/** AES-GCM 加密 JSON 快照，输出可 JSON 序列化的信封 */
async function encryptBackup(plain: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
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

/**
 * 执行一次备份任务。
 *
 * @param db 数据库绑定/客户端
 * @param envObj 环境变量来源（Worker env 或 Node process.env 形状，
 *   仅读取 BACKUP_ENCRYPTION_KEY / BACKUP_WEBHOOK_URL 两个键）
 */
export async function runBackupTask(
  db: D1Database | Database,
  envObj?: Record<string, unknown>
): Promise<BackupTaskResult> {
  const encryptionKey =
    (typeof envObj?.BACKUP_ENCRYPTION_KEY === "string" && envObj.BACKUP_ENCRYPTION_KEY) ||
    process.env.BACKUP_ENCRYPTION_KEY;
  const webhookUrl =
    (typeof envObj?.BACKUP_WEBHOOK_URL === "string" && envObj.BACKUP_WEBHOOK_URL) ||
    process.env.BACKUP_WEBHOOK_URL;

  if (!webhookUrl) {
    return { success: true, pushed: false, skipped: "未配置 BACKUP_WEBHOOK_URL，跳过备份推送" };
  }
  if (!encryptionKey) {
    // 强制门控：备份含明文密钥，无加密钥时拒绝外发而非降级明文
    return { success: false, skipped: "未配置 BACKUP_ENCRYPTION_KEY，拒绝明文外发备份" };
  }
  if (!/^https?:\/\//i.test(webhookUrl)) {
    return { success: false, skipped: "BACKUP_WEBHOOK_URL 必须是 http(s) 地址" };
  }

  const snapshot = await buildConfigBackup(db as never);
  const plain = JSON.stringify(snapshot, bigintReplacer);
  const encrypted = await encryptBackup(plain, encryptionKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "FWP-Backup/1.0",
      },
      body: encrypted,
      signal: controller.signal,
    });
    if (!res.ok) {
      return { success: false, skipped: `接收端返回 HTTP ${res.status}`, sizeBytes: encrypted.length };
    }
    return { success: true, pushed: true, sizeBytes: encrypted.length };
  } catch (err) {
    return {
      success: false,
      skipped: `推送失败: ${err instanceof Error ? err.message : String(err)}`,
      sizeBytes: encrypted.length,
    };
  } finally {
    clearTimeout(timer);
  }
}
