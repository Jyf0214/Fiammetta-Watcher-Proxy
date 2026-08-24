/**
 * 管理后台两步验证（2FA）存储与校验
 *
 * TOTP secret 经 AES-GCM 加密后存于 configs 表 system:admin_2fa 键
 * （加密主密钥由 JWT_SECRET 派生）——数据库泄露时攻击者仅有
 * 密文，无法自行通过 2FA 验证。
 *
 * 注册流程（防误锁）：
 * 1. begin   → 生成临时 secret 返回给前端展示（此时不落库、不启用）
 * 2. confirm → 用该 secret 的一个有效验证码确认后才持久化并启用
 * 3. disable → 需当前有效验证码才能关闭（防止会话劫持者直接关掉 2FA）
 */

import { getConfig } from "../../worker/src/config";
import type { WorkerEnv } from "../../worker/src/config";
import { verifyTotp, generateTotpSecret, buildOtpauthUri } from "./totp";
import type { Database } from "@/lib/prisma";

export const ADMIN_2FA_CONFIG_KEY = "system:admin_2fa";

interface Stored2FA {
  enabled: boolean;
  /** base32 secret 的 AES-GCM 密文信封 */
  secretEnc: { iv: string; data: string };
  createdAt: number;
}

/** 加密主密钥：对 ADMIN_JWT_SECRET 取 SHA-256 得到 AES-256 */
async function deriveKey(adminJwtSecret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(adminJwtSecret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));
}

async function readStored(
  db: D1Database | Database,
  env?: WorkerEnv
): Promise<Stored2FA | null> {
  const raw = await getConfig(db as D1Database, ADMIN_2FA_CONFIG_KEY, env);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Stored2FA>;
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof parsed.secretEnc?.iv !== "string" || typeof parsed.secretEnc?.data !== "string"
    ) {
      return null;
    }
    return {
      enabled: parsed.enabled === true,
      secretEnc: { iv: parsed.secretEnc.iv, data: parsed.secretEnc.data },
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
    };
  } catch {
    console.warn("[admin-2fa] 配置 JSON 解析失败，按未启用处理");
    return null;
  }
}

/**
 * 解密 secret（仅内部使用）
 */
async function decryptSecret(stored: Stored2FA, adminJwtSecret: string): Promise<string | null> {
  try {
    const key = await deriveKey(adminJwtSecret);
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        // TS 5.7+ 将 Uint8Array 泛型区分为 ArrayBufferLike；WebCrypto 运行时
        // 接受该视图，与 totp.ts 的 importKey/sign 处同一规避方式
        iv: fromBase64(stored.secretEnc.iv) as unknown as ArrayBuffer,
      },
      key,
      fromBase64(stored.secretEnc.data) as unknown as ArrayBuffer
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/**
 * 查询 2FA 是否已启用（管理设置页展示用：配置缺失/解析失败/读库失败
 * 一律按未启用，不抛错——避免配置脏数据让设置页报错）
 */
export async function is2faEnabled(db: D1Database | Database, env?: WorkerEnv): Promise<boolean> {
  try {
    const stored = await readStored(db, env);
    return stored?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * 登录链路专用严格变体：与 is2faEnabled 的差异仅在 DB 读取异常时
 * **向上抛错**而非吞掉返回 false——登录关卡必须 fail-closed，否则一次
 * 瞬时 DB 抖动就会把两步验证整段跳过。配置缺失/JSON 损坏仍按未启用
 * （那是数据态，不是基础设施故障）。
 */
export async function is2faEnabledStrict(db: D1Database | Database, env?: WorkerEnv): Promise<boolean> {
  const raw = await getConfig(db as D1Database, ADMIN_2FA_CONFIG_KEY, env);
  if (!raw) return false;
  const stored = await readStored(db, env);
  return stored?.enabled === true;
}

export interface BeginResult {
  secret: string;
  otpauthUri: string;
}

/** 步骤 1：生成待确认的注册信息（不落库） */
export function beginEnrollment(account: string): BeginResult {
  const secret = generateTotpSecret();
  return { secret, otpauthUri: buildOtpauthUri(secret, account) };
}

/**
 * 步骤 2：确认启用——验证码对该 secret 有效时才加密落库并置 enabled
 *
 * @returns true 启用成功；false 验证码无效
 */
export async function confirmEnrollment(
  db: D1Database | Database,
  adminJwtSecret: string,
  secretBase32: string,
  code: string
): Promise<boolean> {
  if (!(await verifyTotp(secretBase32, code))) return false;

  const key = await deriveKey(adminJwtSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(secretBase32)
  );

  const stored: Stored2FA = {
    enabled: true,
    secretEnc: { iv: toBase64(iv), data: toBase64(new Uint8Array(ciphertext)) },
    createdAt: Math.floor(Date.now() / 1000),
  };

  await upsertConfig(db, JSON.stringify(stored));
  return true;
}

/**
 * 关闭 2FA：需提供当前有效的 TOTP 码（解密 secret 校验），防止
 * 被劫持的会话直接关闭两步验证
 */
export async function disable2fa(
  db: D1Database | Database,
  env: WorkerEnv | undefined,
  adminJwtSecret: string,
  code: string
): Promise<{ ok: boolean; reason?: string }> {
  const stored = await readStored(db, env);
  if (!stored || !stored.enabled) return { ok: false, reason: "not_enabled" };
  const secret = await decryptSecret(stored, adminJwtSecret);
  if (!secret) return { ok: false, reason: "decrypt_failed" };
  if (!(await verifyTotp(secret, code))) return { ok: false, reason: "bad_code" };
  await upsertConfig(db, JSON.stringify({ ...stored, enabled: false }));
  return { ok: true };
}

/**
 * 登录流程校验：解密 secret 并核对验证码
 */
export async function verifyLoginCode(
  db: D1Database | Database,
  env: WorkerEnv | undefined,
  adminJwtSecret: string,
  code: string
): Promise<boolean> {
  const stored = await readStored(db, env);
  if (!stored || !stored.enabled) return true; // 未启用直接放行
  const secret = await decryptSecret(stored, adminJwtSecret);
  if (!secret) return false; // 解密失败按验证不通过（密钥轮换等异常场景）
  return verifyTotp(secret, code);
}

// ==================== configs 写入 ====================

async function upsertConfig(db: D1Database | Database, value: string): Promise<void> {
  // 直接操作 Prisma client（createDb 全局缓存）；configs.updatedAt 单调
  // 补偿沿用 config.ts 同语义：库中当前值+1 为下限
  const client = db as never as import("@/lib/prisma").Database;
  const now = Math.floor(Date.now() / 1000);
  let dbUpdatedAt = 0;
  try {
    const row = await client.configs.findFirst({
      where: { key: ADMIN_2FA_CONFIG_KEY },
      select: { updatedAt: true },
    });
    dbUpdatedAt = row?.updatedAt ?? 0;
  } catch {
    // 读库失败退回时间戳兜底
  }
  const ts = Math.max(now, dbUpdatedAt + 1);
  await client.configs.upsert({
    where: { key: ADMIN_2FA_CONFIG_KEY },
    create: { id: crypto.randomUUID(), key: ADMIN_2FA_CONFIG_KEY, value, updatedAt: ts },
    update: { value, updatedAt: ts },
  });
}
