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
import {
  CHANNEL_TYPE_LABELS,
  COOLDOWN_MAX,
  COOLDOWN_MIN,
  DEFAULT_EVENTS,
  FALLBACK_CONFIG,
  HEADER_KEY_MAX_LENGTH,
  HEADER_VALUE_MAX_LENGTH,
  MAX_CHANNELS,
  NAME_MAX_LENGTH,
  OPTIONS_KEY_MAX_LENGTH,
  OPTIONS_VALUE_MAX_LENGTH,
  RETENTION_MAX,
  RETENTION_MIN,
  URL_MAX_LENGTH,
  type ChannelType,
  type EventConfig,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationsConfig,
} from "./notification-types";
import { renderNotificationRequest } from "./notification-channels";
import { isSafeUpstreamUrl } from "./ssrf";

export {
  CHANNEL_TYPE_LABELS,
  DEFAULT_EVENTS,
  FALLBACK_CONFIG,
  MAX_CHANNELS,
  URL_MAX_LENGTH,
  type ChannelType,
  type EventConfig,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationsConfig,
};

/** configs 表中通知配置的存储键 */
export const NOTIFICATIONS_CONFIG_KEY = "system:notifications";

/** 旧版本事件名映射（兼容已保存的旧配置） */
const LEGACY_EVENT_NAME_MAP: Record<string, keyof EventConfig> = {
  platform_open: "platformCircuitTripped",
  platform_recovered: "platformRecovered",
  key_manually_disabled: "keyManuallyDisabled",
  backup_failed: "backupFailed",
};

const VALID_CHANNEL_TYPES: ReadonlySet<ChannelType> = new Set<ChannelType>([
  "telegram",
  "bark",
  "serverchan",
  "lark",
  "wecom",
  "slack",
  "generic",
  "backup",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampString(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, max);
}

function parseStringMap(
  value: unknown,
  keyMax: number,
  valueMax: number,
  parentName: string,
  strict: boolean
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") {
      const msg = `通道 ${parentName} 的 ${k} 不是字符串，已丢弃`;
      if (strict) throw new Error(msg);
      console.warn(`[notifier] ${msg}`);
      continue;
    }
    const kk = k.trim().slice(0, keyMax);
    if (!kk) continue;
    out[kk] = v.slice(0, valueMax);
  }
  return out;
}

function parseChannel(
  item: unknown,
  index: number,
  strict: boolean
): NotificationChannel | null {
  if (typeof item !== "object" || item === null) {
    if (strict) throw new Error("通道条目必须是对象");
    return null;
  }
  const c = item as Record<string, unknown>;
  const rawType = typeof c.type === "string" ? c.type.trim() : "generic";
  if (!VALID_CHANNEL_TYPES.has(rawType as ChannelType)) {
    if (strict) throw new Error(`通道 #${index + 1} 的类型 ${rawType} 非法`);
    return null;
  }
  const type = rawType as ChannelType;
  const name = clampString(c.name, NAME_MAX_LENGTH);
  const url = typeof c.url === "string" ? c.url.trim() : "";
  const idRaw = typeof c.id === "string" ? c.id.trim() : "";
  const id = UUID_RE.test(idRaw) ? idRaw : crypto.randomUUID();
  // enabled=false 通道允许 url 暂时为空（占位禁用态），strict 模式下也允许；
  // 启用态必须 url 非空且通过 http(s) + SSRF 校验
  const enabled = c.enabled === undefined ? true : c.enabled === true;
  if (!url && enabled) {
    if (strict) throw new Error(`通道 #${index + 1} 的 URL 不能为空`);
    return null;
  }
  if (url) {
    if (url.length > URL_MAX_LENGTH || !/^https?:\/\//i.test(url)) {
      if (strict) throw new Error(`通道 ${name || url.slice(0, 32)} 的 URL 非法（仅支持 http/https）`);
      return null;
    }
    // SSRF 防御（复用 src/lib/ssrf.ts 同步校验）：拦截指向内网/云元数据/localhost 的 URL
    // 仅对启用通道生效——禁用通道即便内网也不发起请求，无实际风险
    if (enabled) {
      const ssrf = isSafeUpstreamUrl(url);
      if (!ssrf.safe) {
        if (strict) throw new Error(`通道 ${name || url.slice(0, 32)} 的 URL 不安全：${ssrf.reason ?? "内网或本地地址"}`);
        console.warn(`[notifier] 通道 ${name || url.slice(0, 32)} 的 URL 跳过（${ssrf.reason ?? "内网或本地地址"}）`);
        return null;
      }
    }
  }
  const channelLabel = name || `channel-${index + 1}`;
  const options = parseStringMap(c.options, OPTIONS_KEY_MAX_LENGTH, OPTIONS_VALUE_MAX_LENGTH, channelLabel, strict);
  const headers = parseStringMap(c.headers, HEADER_KEY_MAX_LENGTH, HEADER_VALUE_MAX_LENGTH, channelLabel, strict);
  return {
    id,
    name: channelLabel,
    type,
    url,
    enabled,
    options,
    headers,
  };
}

/**
 * 解析并校验通知配置。
 *
 * 写入路径（管理 API PUT）strict=true 抛错拒绝；读取路径宽松——非法字段
 * 回退默认值，不因历史脏数据阻断请求路径。
 *
 * 旧版本（v1）配置自动迁移：
 * - 通道缺 type → generic
 * - 通道缺 id → 生成 uuid
 * - 通道缺 enabled/options/headers → 默认值
 * - events.platformOpen → events.platformCircuitTripped
 */
export function parseNotificationsConfig(
  raw: string | null | undefined,
  opts: { strict?: boolean } = {}
): NotificationsConfig {
  const strict = opts.strict ?? false;
  const fallback: NotificationsConfig = {
    ...FALLBACK_CONFIG,
    events: { ...FALLBACK_CONFIG.events },
    channels: [],
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
  for (let i = 0; i < channelsRaw.length; i++) {
    const ch = parseChannel(channelsRaw[i], i, strict);
    if (ch) channels.push(ch);
  }

  const eventsRaw = typeof v.events === "object" && v.events !== null ? (v.events as Record<string, unknown>) : {};
  const events: EventConfig = { ...DEFAULT_EVENTS };
  for (const [key, mapped] of Object.entries(LEGACY_EVENT_NAME_MAP)) {
    if (typeof eventsRaw[key] === "boolean") {
      (events as unknown as Record<string, unknown>)[mapped] = eventsRaw[key];
    }
  }
  for (const [k, v] of Object.entries(events)) {
    if (typeof eventsRaw[k] === "boolean") {
      (events as unknown as Record<string, boolean>)[k] = eventsRaw[k];
    }
  }

  let cooldownMinutes = FALLBACK_CONFIG.cooldownMinutes;
  if (v.cooldownMinutes !== undefined) {
    const n = Number(v.cooldownMinutes);
    if (!Number.isFinite(n) || n < COOLDOWN_MIN || n > COOLDOWN_MAX) {
      if (strict) throw new Error(`cooldownMinutes 必须是 ${COOLDOWN_MIN}-${COOLDOWN_MAX} 的数字`);
    } else {
      cooldownMinutes = Math.floor(n);
    }
  }

  let backupRetentionDays = FALLBACK_CONFIG.backupRetentionDays;
  if (v.backupRetentionDays !== undefined) {
    const n = Number(v.backupRetentionDays);
    if (!Number.isFinite(n) || n < RETENTION_MIN || n > RETENTION_MAX) {
      if (strict) throw new Error(`backupRetentionDays 必须是 ${RETENTION_MIN}-${RETENTION_MAX} 的数字`);
    } else {
      backupRetentionDays = Math.floor(n);
    }
  }

  return {
    enabled: v.enabled === true,
    channels,
    events,
    cooldownMinutes,
    backupRetentionDays,
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
    if (!config.enabled) return;
    const eventEnabled: Record<NotificationEvent, boolean> = {
      key_banned: config.events.keyBanned,
      platform_circuit_tripped: config.events.platformCircuitTripped,
      platform_recovered: config.events.platformRecovered,
      platform_degraded: config.events.platformDegraded,
      all_unavailable: config.events.allUnavailable,
      quota_threshold: config.events.quotaThreshold,
      key_manually_disabled: config.events.keyManuallyDisabled,
      backup_failed: config.events.backupFailed,
    };
    if (!eventEnabled[event]) return;
    if (isCoolingDown(`${event}:${opts.eventKey ?? ""}`, config.cooldownMinutes * 60_000)) return;

    // backup 类型通道不走 sendNotification — 由 src/lib/backup.ts 内部直接处理
    const notifiableChannels = config.channels.filter((c) => c.enabled && c.type !== "backup");
    if (notifiableChannels.length === 0) return;

    await Promise.allSettled(
      notifiableChannels.map(async (channel) => {
        const rendered = renderNotificationRequest({ title, body, event, channel });
        if (!rendered) {
          console.error(`[notifier] 通道 ${channel.name} 类型 ${channel.type} 渲染失败，跳过`);
          return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
        try {
          const res = await fetch(rendered.url, {
            method: "POST",
            headers: rendered.headers,
            body: rendered.body,
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
