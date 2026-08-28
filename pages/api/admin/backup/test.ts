/**
 * 备份推送测试端点
 *
 * POST /api/admin/backup/test
 * body: { url: string, secret: string, iterations?: number, kdf?: "pbkdf2-sha256" | "raw-sha256" }
 *
 * 行为：用指定 URL + secret 加密测试快照（空 platforms/keys）→ POST；
 * 返回 { ok, status, durationMs, error? }。不写 history（避免污染真实数据）。
 *
 * 默认 kdf=raw-sha256（兼容旧接收端）；iterations 默认 100000。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { checkCsrfOrigin, isSafeUrl } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { getClientIp } from "../auth";

const SEND_TIMEOUT_MS = 30_000;
const PBKDF2_DEFAULT_ITERATIONS = 100_000;

interface EnvelopeV1 {
  encrypted: true;
  alg: "AES-GCM-256";
  iv: string;
  data: string;
}
interface EnvelopeV2 {
  encrypted: true;
  alg: "AES-GCM-256";
  kdf: "pbkdf2-sha256";
  iter: number;
  salt: string;
  iv: string;
  data: string;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function deriveV1(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt"]);
}

async function deriveV2(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
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
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
}

async function encrypt(plain: string, secret: string, kdf: string, iterations: number): Promise<string> {
  if (kdf === "raw-sha256") {
    const key = await deriveV1(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
    const env: EnvelopeV1 = {
      encrypted: true,
      alg: "AES-GCM-256",
      iv: toBase64(iv),
      data: toBase64(new Uint8Array(ct)),
    };
    return JSON.stringify(env);
  }
  // pbkdf2-sha256
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveV2(secret, salt, iterations);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
  const env: EnvelopeV2 = {
    encrypted: true,
    alg: "AES-GCM-256",
    kdf: "pbkdf2-sha256",
    iter: iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(ct)),
  };
  return JSON.stringify(env);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    res.status(405).json({ success: false, error: { message: "Method not allowed", type: "invalid_request_error" } });
    return;
  }
  if (!checkCsrfOrigin(req, res)) return;
  if (!(await checkAdminRateLimit(admin.adminId, res))) return;

  try {
    const input = req.body as {
      url?: unknown; secret?: unknown; iterations?: unknown; kdf?: unknown;
    };
    if (typeof input.url !== "string" || !/^https?:\/\//i.test(input.url)) {
      res.status(400).json({
        success: false,
        error: { message: "url 必填且必须是 http(s) 地址", type: "invalid_request_error" },
      });
      return;
    }
    // SSRF 防御：使用 isSafeUrl 含 DNS 解析层，拦截 DNS Rebinding / AAAA-only
    // 内网域名，与 import / platforms / test-model 等其他 admin 端点策略一致
    const ssrf = await isSafeUrl(input.url);
    if (!ssrf.safe) {
      res.status(400).json({
        success: false,
        error: { message: `URL 内网或本地地址：${ssrf.reason ?? "不安全"}`, type: "invalid_request_error" },
      });
      return;
    }
    if (typeof input.secret !== "string" || !input.secret) {
      res.status(400).json({
        success: false,
        error: { message: "secret 必填且必须是非空字符串", type: "invalid_request_error" },
      });
      return;
    }
    const kdf = input.kdf === "pbkdf2-sha256" ? "pbkdf2-sha256" : "raw-sha256";
    const iterations = Number.isFinite(Number(input.iterations))
      ? Math.max(1, Math.floor(Number(input.iterations)))
      : PBKDF2_DEFAULT_ITERATIONS;

    // 测试快照：最小可解析 config-backup 结构（不写库）
    const testSnapshot = {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      exportType: "config-backup-test",
      platforms: [],
      platformModels: [],
      configs: [],
      apiKeys: [],
    };
    const plain = JSON.stringify(testSnapshot);
    const envelope = await encrypt(plain, input.secret, kdf, iterations);

    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    let status: "success" | "failed" = "failed";
    let httpStatus: number | null = null;
    let error: string | null = null;
    try {
      const res2 = await fetch(input.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "FWP-Backup-Test/2.0",
        },
        body: envelope,
        signal: controller.signal,
      });
      // 必须消费响应体释放 keep-alive
      if (typeof res2.arrayBuffer === "function") {
        try {
          await res2.arrayBuffer();
        } catch {
          await res2.body?.cancel().catch(() => {});
        }
      }
      httpStatus = res2.status;
      if (res2.ok) {
        status = "success";
      } else {
        error = `HTTP ${res2.status}`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - start;

    // 审计：测试推送对外部接收端发起真实请求，必须留痕可追溯。
    // URL 仅记录 host，避免内网拓扑泄露到审计日志
    let urlHost = "<invalid-url>";
    try { urlHost = new URL(input.url).host; } catch { /* 保持占位 */ }
    const db = await createDb();
    await db.auditLogs.create({
      data: {
        id: crypto.randomUUID(),
        adminId: getAuditAdminId(admin),
        action: "test_backup_push",
        detail: JSON.stringify({
          urlHost,
          status,
          httpStatus,
          durationMs,
          kdf,
          iterations,
          ...(error ? { error } : {}),
        }),
        ip: getClientIp(req),
        createdAt: Math.floor(Date.now() / 1000),
      },
    });

    if (status === "success") {
      res.status(200).json({
        success: true,
        data: { ok: true, status: httpStatus, durationMs, kdf, iterations },
      });
    } else {
      res.status(502).json({
        success: false,
        data: { ok: false, status: httpStatus, error, durationMs, kdf, iterations },
      });
    }
  } catch (err) {
    console.error(
      "[API /api/admin/backup/test] 操作失败:",
      err instanceof Error ? err.message : String(err)
    );
    res.status(500).json({ success: false, error: { message: "操作失败", type: "server_error" } });
  }
}
