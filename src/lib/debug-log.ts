/**
 * 失败请求留痕（调试）
 *
 * 上游返回非 2xx 时把下游原始请求体与上游响应片段落库到 request_debug_logs，
 * 供管理后台「请求日志」页复现排查。设计约束：
 * - 仅失败请求记录（成功请求不留痕，避免体积膨胀）；
 * - 字段截断 16KB——留痕目的是定位参数/响应问题，不是全量抓包；
 * - 写入失败静默（console.error），绝不影响代理主路径与原错误响应；
 * - 过期清理挂在 log-archive cron（与日志保留期同窗）。
 */

import { createDb } from "@/lib/prisma";
import type { Database } from "@/lib/prisma";

const MAX_FIELD_BYTES = 16 * 1024;

/** UTF-8 字节安全截断（避免切断多字节字符产生乱码） */
function truncateUtf8(value: string | undefined | null): string | null {
  if (!value) return null;
  if (value.length <= MAX_FIELD_BYTES) return value;
  const buf = new TextEncoder().encode(value);
  if (buf.length <= MAX_FIELD_BYTES) return value;
  let cut = MAX_FIELD_BYTES;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return new TextDecoder().decode(buf.subarray(0, cut));
}

export interface DebugLogEntry {
  /** 关联的 request_logs.id（同一请求的主日志），便于从日志页跳转 */
  requestLogId?: string;
  model: string;
  platformId?: string | null;
  status: number;
  requestBody?: string | null;
  responseSnippet?: string | null;
  errorMessage?: string | null;
}

/**
 * 落库一条失败请求留痕（fire-and-forget，调用方无需 await）
 */
export async function saveDebugLog(
  db: D1Database | Database,
  envType: string | undefined,
  entry: DebugLogEntry
): Promise<void> {
  try {
    const prisma = await createDb({ DB: db as D1Database, DB_TYPE: envType });
    await prisma.requestDebugLogs.create({
      data: {
        id: crypto.randomUUID(),
        requestLogId: entry.requestLogId ?? null,
        model: entry.model,
        platformId: entry.platformId ?? null,
        status: entry.status,
        requestBody: truncateUtf8(entry.requestBody),
        responseSnippet: truncateUtf8(entry.responseSnippet),
        errorMessage: truncateUtf8(entry.errorMessage),
        createdAt: Math.floor(Date.now() / 1000),
      },
    });
  } catch (err) {
    console.error(
      "[debug-log] 留痕写入失败:",
      err instanceof Error ? err.message : String(err)
    );
  }
}
