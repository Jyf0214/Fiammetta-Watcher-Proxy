/**
 * 系统级「开发模式」开关
 *
 * 存储于 configs 表 system:developer_mode 键，JSON 结构 { enabled: boolean }。
 *
 * 设计约束：
 * - 进程内 TTL 缓存（与 model-pricing/notifications 同模式）：避免每次代理请求
 *   路径都查 configs 表，TTL=60 秒内复用上次结果；
 * - 写后立即失效本进程缓存，避免"自己刚开/关但当前请求仍按旧值走"的滞后；
 * - 关闭状态下所有调试能力（详细日志、调试面板）一律不输出/不暴露；
 * - 仅 admin 后端调用 isDevMode()；前端不可强制开启（避免客户端伪造）。
 */

import { getConfig } from "../../worker/src/config";
import type { WorkerEnv } from "../../worker/src/config";
import type { Database } from "@/lib/prisma";

type DbInput = D1Database | Database;

/** configs 表中开发模式开关的存储键 */
export const DEV_MODE_CONFIG_KEY = "system:developer_mode";

/** 进程内缓存 TTL：60 秒。管理后台切换后立即强制刷新（见 invalidateDevModeCache） */
const DEV_MODE_CACHE_TTL_MS = 60_000;

interface DevModeState {
  enabled: boolean;
  loadedAt: number;
}

let cache: DevModeState | null = null;

/**
 * 解析开发模式配置 JSON。
 *
 * 写入路径（管理 API PUT）与读取路径共用本函数；strict=true 时非法数据抛错
 * 写入拒绝，strict=false 时告警并返回 false（读取路径不因历史脏数据报错）。
 */
export function parseDevMode(
  raw: string | null | undefined,
  opts: { strict?: boolean } = {}
): boolean {
  const strict = opts.strict ?? false;
  if (raw == null || raw === "") return false;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    if (strict) throw new Error("开发模式配置不是合法 JSON");
    console.warn("[dev-mode] 存储的 JSON 解析失败，按关闭处理");
    return false;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    if (strict) throw new Error("开发模式配置必须是对象 { enabled: boolean }");
    return false;
  }
  const v = (data as Record<string, unknown>).enabled;
  if (typeof v !== "boolean") {
    if (strict) throw new Error("开发模式配置 enabled 字段必须是布尔值");
    return false;
  }
  return v;
}

/** 序列化为存储字符串（结构稳定，便于配置 diff） */
export function serializeDevMode(enabled: boolean): string {
  return JSON.stringify({ enabled });
}

/**
 * 同步读取（仅依赖已加载缓存）：未加载返回 false。供请求热路径用，
 * 不会触发 DB 调用。
 */
export function isDevModeCached(): boolean {
  if (!cache) return false;
  if (Date.now() - cache.loadedAt > DEV_MODE_CACHE_TTL_MS) return false;
  return cache.enabled;
}

/**
 * 异步读取（带 TTL 缓存与 DB 回退）。代理请求热路径可在异步上下文调用；
 * DB 失败时返回 false（默认关闭——保守起见，未确认开启前一律走生产路径）。
 */
export async function isDevMode(
  db?: DbInput,
  env?: WorkerEnv
): Promise<boolean> {
  if (cache && Date.now() - cache.loadedAt <= DEV_MODE_CACHE_TTL_MS) {
    return cache.enabled;
  }
  if (!db) return false;
  try {
    const raw = await getConfig(db as D1Database, DEV_MODE_CONFIG_KEY, env);
    const enabled = parseDevMode(raw);
    cache = { enabled, loadedAt: Date.now() };
    return enabled;
  } catch (err) {
    console.warn(
      "[dev-mode] 读取配置失败，按关闭处理:",
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}

/**
 * 强制清除进程内缓存。PUT 路径写入新值后立即调用，避免同进程后续请求
 * 仍按旧 enabled 状态走 TTL 时长。
 */
export function invalidateDevModeCache(): void {
  cache = null;
}

/**
 * 便捷调试日志：仅在开发模式开启时输出到 stdout。
 *
 * 用途：请求路径在关键决策点（路由选择/熔断切换/限流触发）可调用本函数
 * 打印额外上下文；关闭状态下函数为空操作，零开销。
 *
 * 仅同步读取缓存（isDevModeCached），不会触发 DB 调用，代理热路径
 * 调用安全。
 */
export function devLog(scope: string, message: string, meta?: unknown): void {
  if (!isDevModeCached()) return;
  if (meta !== undefined) {
    console.log(`[dev:${scope}] ${message}`, meta);
  } else {
    console.log(`[dev:${scope}] ${message}`);
  }
}
