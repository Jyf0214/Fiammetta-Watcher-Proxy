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
import { checkCooldown, recordSent, recordHistory } from "./notification-store";

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

// ==================== 冷却去重（v2：持久化到 DB + 进程内回退） ====================
//
// 冷却状态从 notification_cooldowns 表读取/写入，多实例部署保持一致。
// 原进程内 lastSentAt Map 已弃用（v1 行为），由 v2 store 替代。
// P1-2 修复：DB 不可用时回退到进程内 Map，保证本实例冷却仍生效（避免重试风暴）。
// 详见 src/lib/notification-store.ts。

/** 进程内回退冷却表：DB 写入失败时使用，仅本实例有效 */
const fallbackCooldowns = new Map<string, number>();

/**
 * 检查冷却：先查 DB（最权威，多实例一致），DB 抛错时回退到进程内 Map
 *
 * @returns true = 在冷却中（应跳过）
 */
async function checkCooldownWithFallback(
  eventKey: string,
  cooldownMinutes: number
): Promise<boolean> {
  if (cooldownMinutes <= 0) return false;
  // 间歇性故障处理：DB 与 fallback map 取并集——任意一边命中冷却即视为冷却中。
  // 场景：上一次 recordSent 抛错写了 fallback map（DB 写入失败），
  // 下次 checkCooldown 查 DB 可能成功（间歇恢复）但找不到记录，
  // 此时必须看 fallback map 才能保留冷却状态。
  let dbCooling = false;
  let dbAvailable = true;
  try {
    dbCooling = await checkCooldown(eventKey, cooldownMinutes);
  } catch (err) {
    dbAvailable = false;
    console.error(
      "[notifier] 冷却查询失败，回退到进程内:",
      err instanceof Error ? err.message : String(err)
    );
  }
  if (dbCooling) return true;
  // fallback 命中即视为冷却（DB 写失败留下的本实例冷却状态）
  const last = fallbackCooldowns.get(eventKey);
  if (last) return Date.now() - last < cooldownMinutes * 60_000;
  // DB 抛错 + fallback 无记录 → 放行（无任何冷却证据）
  if (!dbAvailable) return false;
  // DB 成功 + 无冷却 + fallback 无记录 → 放行
  return false;
}

/**
 * 记录冷却：先写 DB（多实例同步），DB 失败时回退到进程内 Map；
 * 写 DB 成功时清理本实例 fallback（避免"成功写入但 fallback 残留导致
 * 下次 checkCooldown 误命中"）
 */
async function recordSentWithFallback(eventKey: string): Promise<void> {
  try {
    await recordSent(eventKey);
    fallbackCooldowns.delete(eventKey);
  } catch (err) {
    console.error(
      "[notifier] 冷却写入失败，回退到进程内:",
      err instanceof Error ? err.message : String(err)
    );
    fallbackCooldowns.set(eventKey, Date.now());
  }
}

// 测试钩子
export function resetNotifierForTests(): void {
  cachedConfig = null;
  configLoadedAt = 0;
  loadingPromise = null;
  fallbackCooldowns.clear();
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== 发送 ====================

const SEND_TIMEOUT_MS = 5_000;
/** 重试次数：除首次外再尝试 2 次（共 3 次），覆盖瞬时网络抖动 */
const SEND_MAX_RETRIES = 2;
/** 指数退避基础值（ms）：第 1 次重试 1×，第 2 次 2× */
const RETRY_BACKOFF_BASE_MS = 1_000;
/** 4xx 不重试（请求本身错误，重试无用）；5xx/网络错误才重试 */
function shouldRetryHttpStatus(status: number): boolean {
  return status >= 500 && status < 600;
}

/** 等待指定毫秒（测试时可被覆写） */
let sleepImpl: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 测试钩子：替换 sleep（fake timer 不兼容 AbortController 时使用） */
export function _setSleepForTests(fn: (ms: number) => Promise<void>): void {
  sleepImpl = fn;
}
const sleep = (ms: number): Promise<void> => sleepImpl(ms);

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

    // backup 类型通道不走 sendNotification — 由 src/lib/backup.ts 内部直接处理
    const notifiableChannels = config.channels.filter((c) => c.enabled && c.type !== "backup");
    if (notifiableChannels.length === 0) return;

    // 持久化冷却去重：DB 写一次（失败仅 console.error，不阻塞）；同实例下轮调用
    // 都会因 checkCooldown 命中而被拦截；多实例部署同步生效
    // P1-2 修复：DB 写失败时回退到进程内 lastSentAt Map，保证本实例冷却仍生效
    const cooldownKey = `${event}:${opts.eventKey ?? ""}`;
    if (await checkCooldownWithFallback(cooldownKey, config.cooldownMinutes)) return;
    await recordSentWithFallback(cooldownKey);

    await Promise.allSettled(
      notifiableChannels.map(async (channel) => {
        const rendered = renderNotificationRequest({ title, body, event, channel });
        if (!rendered) {
          console.error(`[notifier] 通道 ${channel.name} 类型 ${channel.type} 渲染失败，跳过`);
          return;
        }
        // 二次 SSRF 校验：parse 阶段已拦截一次，但管理员可能在缓存窗口内通过
        // 外部直接改 DB 注入内网 URL；这里再次确认防御
        const ssrf = isSafeUpstreamUrl(rendered.url);
        if (!ssrf.safe) {
          console.error(
            `[notifier] 通道 ${channel.name} 的 URL 在发送时拦截（${ssrf.reason ?? "不安全"}）`
          );
          await recordHistory({
            channelId: channel.id,
            channelName: channel.name,
            channelType: channel.type,
            event,
            title,
            body,
            status: "failed",
            httpStatus: null,
            error: `SSRF 拦截: ${ssrf.reason ?? "内网或本地地址"}`,
            sizeBytes: 0,
            durationMs: 0,
          });
          return;
        }
        const start = Date.now();
        let status: "success" | "failed" = "failed";
        let httpStatus: number | null = null;
        let error: string | null = null;

        // 重试循环：SEND_MAX_RETRIES + 1 次总尝试；5xx/网络错误/超时触发重试，
        // 4xx 不重试（请求体错），3xx/2xx 直接成功/失败
        outer: for (let attempt = 0; attempt <= SEND_MAX_RETRIES; attempt++) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
          try {
            const res = await fetch(rendered.url, {
              method: "POST",
              headers: rendered.headers,
              body: rendered.body,
              signal: controller.signal,
            });
            // 必须消费响应体释放 keep-alive 连接（同 backup / upstream-proxy 修复）
            if (typeof res.arrayBuffer === "function") {
              try {
                await res.arrayBuffer();
              } catch {
                await res.body?.cancel().catch(() => {});
              }
            }
            httpStatus = res.status;
            if (res.ok) {
              status = "success";
              break;
            }
            // 非 2xx
            error = `HTTP ${res.status}`;
            if (!shouldRetryHttpStatus(res.status) || attempt === SEND_MAX_RETRIES) {
              console.error(
                attempt === SEND_MAX_RETRIES
                  ? `[notifier] 通道 ${channel.name} 重试 ${SEND_MAX_RETRIES} 次后仍返回 HTTP ${res.status}`
                  : `[notifier] 通道 ${channel.name} 返回 HTTP ${res.status}（不重试）`
              );
              break;
            }
            // 5xx 且还有重试机会：继续循环前先等待
            console.error(
              `[notifier] 通道 ${channel.name} 第 ${attempt + 1} 次返回 HTTP ${res.status}，准备重试`
            );
          } catch (err) {
            // 网络/超时/Abort：判定为可重试
            error = err instanceof Error ? err.message : String(err);
            if (attempt === SEND_MAX_RETRIES) {
              console.error(
                `[notifier] 通道 ${channel.name} 重试 ${SEND_MAX_RETRIES} 次后仍失败: ${error}`
              );
              break;
            }
            console.error(
              `[notifier] 通道 ${channel.name} 第 ${attempt + 1} 次失败: ${error}，准备重试`
            );
            // fallthrough 到重试等待（finally 清 timer + 循环底 sleep）
          } finally {
            clearTimeout(timer);
          }
          // 重试退避：attempt=0 → 1s, attempt=1 → 2s（指数）
          if (attempt < SEND_MAX_RETRIES) {
            await sleep(RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt));
            continue outer;
          }
        }
        // 写发送历史（旁路：失败仅 console.error，不影响其他通道）
        await recordHistory({
          channelId: channel.id,
          channelName: channel.name,
          channelType: channel.type,
          event,
          title,
          body,
          status,
          httpStatus,
          error,
          sizeBytes: new TextEncoder().encode(rendered.body).length,
          durationMs: Date.now() - start,
        });
      })
    );
  } catch (err) {
    // 顶层兜底：任何异常都不允许冒泡到代理路径
    console.error("[notifier] 通知发送异常:", err instanceof Error ? err.message : String(err));
  }
}
