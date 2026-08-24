/**
 * 告警通知模块
 *
 * 将代理链路的关键异常事件（Key 封禁/平台熔断/平台降级/全平台不可用/
 * 配额阈值跨越）推送到管理员配置的 Webhook 通道。Telegram Bot / Bark /
 * Server酱 等均兼容"POST JSON"语义：其鉴权信息内嵌在 URL 路径/参数中，
 * 本模块只负责统一的 POST {event, title, body, timestamp} 格式。
 *
 * 设计约束（旁路模块，绝不影响代理主路径）：
 * - 发送失败/配置缺失/未启用一律静默降级，仅 console.error；
 * - 同类事件按冷却窗口去重（进程内 Map，单人单实例部署足够）；
 * - DB 绑定复用 batched-writer 捕获的请求路径绑定（见 getBatchedWriterBindings），
 *   也可由调用方显式传入；
 * - 仅使用 fetch/setTimeout，Node 与 Workers 双运行时兼容。
 */

import { getConfig } from "../../worker/src/config";
import type { WorkerEnv } from "../../worker/src/config";
import { getBatchedWriterBindings } from "../../worker/src/batched-writer";
import type { Database } from "@/lib/prisma";

/** configs 表中通知配置的存储键 */
export const NOTIFICATIONS_CONFIG_KEY = "system:notifications";

/** 通知事件类型 */
export type NotificationEvent =
  | "key_banned"
  | "platform_open"
  | "platform_degraded"
  | "all_unavailable"
  | "quota_threshold";

interface NotificationsEventsConfig {
  keyBanned: boolean;
  platformOpen: boolean;
  platformDegraded: boolean;
  allUnavailable: boolean;
  quotaThreshold: boolean;
}

interface NotificationChannel {
  name: string;
  url: string;
}

export interface NotificationsConfig {
  enabled: boolean;
  channels: NotificationChannel[];
  events: NotificationsEventsConfig;
  /** 同类事件冷却分钟数（1-1440），默认 10 */
  cooldownMinutes: number;
}

const DEFAULT_EVENTS: NotificationsEventsConfig = {
  keyBanned: true,
  platformOpen: true,
  platformDegraded: false,
  allUnavailable: true,
  quotaThreshold: true,
};

const MAX_CHANNELS = 20;
const URL_MAX_LENGTH = 2048;

/**
 * 解析并校验通知配置。
 *
 * 写入路径（管理 API PUT）strict=true 抛错拒绝；读取路径宽松——非法字段
 * 回退默认值，不因历史脏数据阻断请求路径。
 */
export function parseNotificationsConfig(
  raw: string | null | undefined,
  opts: { strict?: boolean } = {}
): NotificationsConfig {
  const strict = opts.strict ?? false;
  const fallback: NotificationsConfig = {
    enabled: false,
    channels: [],
    events: { ...DEFAULT_EVENTS },
    cooldownMinutes: 10,
  };
  if (raw == null || raw === "") return fallback;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    if (strict) throw new Error("通知配置不是合法 JSON");
    console.warn("[notifier] 通知配置 JSON 解析失败，按默认值处理");
    return fallback;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    if (strict) throw new Error("通知配置必须是对象");
    return fallback;
  }
  const v = data as Record<string, unknown>;

  const channelsRaw = Array.isArray(v.channels) ? v.channels : [];
  if (channelsRaw.length > MAX_CHANNELS) {
    if (strict) throw new Error(`通道数量超过上限 ${MAX_CHANNELS}`);
    return fallback;
  }
  const channels: NotificationChannel[] = [];
  for (const item of channelsRaw) {
    if (typeof item !== "object" || item === null) {
      if (strict) throw new Error("通道条目必须是对象");
      continue;
    }
    const c = item as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name.trim().slice(0, 100) : "";
    const url = typeof c.url === "string" ? c.url.trim() : "";
    if (!url) {
      if (strict) throw new Error("通道 URL 不能为空");
      continue;
    }
    if (url.length > URL_MAX_LENGTH || !/^https?:\/\//i.test(url)) {
      if (strict) throw new Error(`通道 ${name || url.slice(0, 32)} 的 URL 非法（仅支持 http/https）`);
      continue;
    }
    channels.push({ name: name || `channel-${channels.length + 1}`, url });
  }

  const eventsRaw = typeof v.events === "object" && v.events !== null ? (v.events as Record<string, unknown>) : {};
  const events: NotificationsEventsConfig = {
    keyBanned: typeof eventsRaw.keyBanned === "boolean" ? eventsRaw.keyBanned : DEFAULT_EVENTS.keyBanned,
    platformOpen: typeof eventsRaw.platformOpen === "boolean" ? eventsRaw.platformOpen : DEFAULT_EVENTS.platformOpen,
    platformDegraded: typeof eventsRaw.platformDegraded === "boolean" ? eventsRaw.platformDegraded : DEFAULT_EVENTS.platformDegraded,
    allUnavailable: typeof eventsRaw.allUnavailable === "boolean" ? eventsRaw.allUnavailable : DEFAULT_EVENTS.allUnavailable,
    quotaThreshold: typeof eventsRaw.quotaThreshold === "boolean" ? eventsRaw.quotaThreshold : DEFAULT_EVENTS.quotaThreshold,
  };

  let cooldownMinutes = 10;
  if (v.cooldownMinutes !== undefined) {
    const n = Number(v.cooldownMinutes);
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      if (strict) throw new Error("cooldownMinutes 必须是 1-1440 的数字");
    } else {
      cooldownMinutes = Math.floor(n);
    }
  }

  return {
    enabled: v.enabled === true,
    channels,
    events,
    cooldownMinutes,
  };
}

export function serializeNotificationsConfig(config: NotificationsConfig): string {
  return JSON.stringify(config);
}

// ==================== 快照缓存 ====================

const CONFIG_TTL_MS = 60_000;
let cachedConfig: NotificationsConfig | null = null;
let configLoadedAt = 0;
let loadingPromise: Promise<void> | null = null;

async function loadConfig(db: D1Database | Database, env?: WorkerEnv): Promise<void> {
  try {
    const raw = await getConfig(db as D1Database, NOTIFICATIONS_CONFIG_KEY, env);
    cachedConfig = parseNotificationsConfig(raw);
    configLoadedAt = Date.now();
  } catch (err) {
    // 读库失败沿用旧配置（可能为禁用态）：通知是尽力而为的旁路能力
    console.error(
      "[notifier] 加载通知配置失败，沿用旧配置:",
      err instanceof Error ? err.message : String(err)
    );
    configLoadedAt = Date.now();
  }
}

async function ensureConfigLoaded(db: D1Database | Database, env?: WorkerEnv): Promise<NotificationsConfig> {
  if (cachedConfig && Date.now() - configLoadedAt < CONFIG_TTL_MS) return cachedConfig;
  if (!loadingPromise) {
    loadingPromise = loadConfig(db, env).finally(() => {
      loadingPromise = null;
    });
  }
  await loadingPromise;
  return cachedConfig ?? parseNotificationsConfig(null);
}

// ==================== 冷却去重 ====================

const lastSentAt = new Map<string, number>();

function isCoolingDown(eventKey: string, cooldownMs: number): boolean {
  const last = lastSentAt.get(eventKey);
  if (last && Date.now() - last < cooldownMs) return true;
  lastSentAt.set(eventKey, Date.now());
  return false;
}

// 测试钩子
export function resetNotifierForTests(): void {
  cachedConfig = null;
  configLoadedAt = 0;
  loadingPromise = null;
  lastSentAt.clear();
}

// ==================== 发送 ====================

const SEND_TIMEOUT_MS = 5_000;

/**
 * 发送事件通知
 *
 * @param event - 事件类型
 * @param title - 标题（一行摘要）
 * @param body - 正文详情（可多行）
 * @param opts.db/env - 显式绑定；缺省时复用 batched-writer 捕获的请求路径绑定
 * @param opts.eventKey - 冷却去重键；同一逻辑事件的多次触发共用（如按 keyId 区分）
 */
export async function sendNotification(
  event: NotificationEvent,
  title: string,
  body: string,
  opts: {
    db?: D1Database | Database;
    env?: WorkerEnv;
    eventKey?: string;
  } = {}
): Promise<void> {
  try {
    let db = opts.db;
    let env = opts.env;
    if (!db) {
      const bindings = getBatchedWriterBindings();
      if (!bindings) return;
      db = bindings.db;
      env = env ?? bindings.env;
    }

    const config = await ensureConfigLoaded(db, env);
    if (!config.enabled || config.channels.length === 0) return;
    const eventEnabled: Record<NotificationEvent, boolean> = {
      key_banned: config.events.keyBanned,
      platform_open: config.events.platformOpen,
      platform_degraded: config.events.platformDegraded,
      all_unavailable: config.events.allUnavailable,
      quota_threshold: config.events.quotaThreshold,
    };
    if (!eventEnabled[event]) return;
    if (isCoolingDown(`${event}:${opts.eventKey ?? ""}`, config.cooldownMinutes * 60_000)) return;

    const payload = JSON.stringify({
      event,
      title,
      body,
      timestamp: Math.floor(Date.now() / 1000),
    });

    await Promise.allSettled(
      config.channels.map(async (channel) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
        try {
          const res = await fetch(channel.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "FWP-Notifier/1.0",
            },
            body: payload,
            signal: controller.signal,
          });
          if (!res.ok) {
            console.error(`[notifier] 通道 ${channel.name} 返回 HTTP ${res.status}`);
          }
        } catch (err) {
          console.error(
            `[notifier] 通道 ${channel.name} 发送失败:`,
            err instanceof Error ? err.message : String(err)
          );
        } finally {
          clearTimeout(timer);
        }
      })
    );
  } catch (err) {
    // 顶层兜底：任何异常都不允许冒泡到代理路径
    console.error("[notifier] 通知发送异常:", err instanceof Error ? err.message : String(err));
  }
}
