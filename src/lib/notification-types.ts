/**
 * 通知系统类型定义
 *
 * 单一类型源：通知（event-driven）与备份（cron-driven）共用同一套通道模型
 * 与配置结构，差异化仅在 `ChannelType === "backup"` 时走加密门控 + 多接收端
 * 串行重试。本模块只定义类型与常量，不引任何运行时依赖。
 */

export type ChannelType =
  | "telegram"
  | "bark"
  | "serverchan"
  | "lark"
  | "wecom"
  | "slack"
  | "generic"
  | "backup";

export type NotificationEvent =
  | "key_banned"
  | "platform_circuit_tripped"
  | "platform_recovered"
  | "platform_degraded"
  | "all_unavailable"
  | "quota_threshold"
  | "key_manually_disabled"
  | "backup_failed";

export interface NotificationChannel {
  id: string;
  name: string;
  type: ChannelType;
  url: string;
  enabled: boolean;
  options: Record<string, string>;
  headers: Record<string, string>;
}

export interface EventConfig {
  keyBanned: boolean;
  platformCircuitTripped: boolean;
  platformRecovered: boolean;
  platformDegraded: boolean;
  allUnavailable: boolean;
  quotaThreshold: boolean;
  keyManuallyDisabled: boolean;
  backupFailed: boolean;
}

export interface NotificationsConfig {
  enabled: boolean;
  channels: NotificationChannel[];
  events: EventConfig;
  cooldownMinutes: number;
  backupRetentionDays: number;
}

export const DEFAULT_EVENTS: EventConfig = {
  keyBanned: true,
  platformCircuitTripped: true,
  platformRecovered: true,
  platformDegraded: false,
  allUnavailable: true,
  quotaThreshold: true,
  keyManuallyDisabled: false,
  backupFailed: true,
};

export const FALLBACK_CONFIG: NotificationsConfig = {
  enabled: false,
  channels: [],
  events: { ...DEFAULT_EVENTS },
  cooldownMinutes: 10,
  backupRetentionDays: 30,
};

export const MAX_CHANNELS = 20;
export const URL_MAX_LENGTH = 2048;
export const HEADER_KEY_MAX_LENGTH = 64;
export const HEADER_VALUE_MAX_LENGTH = 1024;
export const OPTIONS_KEY_MAX_LENGTH = 64;
export const OPTIONS_VALUE_MAX_LENGTH = 1024;
export const NAME_MAX_LENGTH = 100;
export const COOLDOWN_MIN = 1;
export const COOLDOWN_MAX = 1440;
export const RETENTION_MIN = 1;
export const RETENTION_MAX = 365;

export const CHANNEL_TYPE_LABELS: Record<ChannelType, string> = {
  telegram: "Telegram Bot",
  bark: "Bark",
  serverchan: "Server酱",
  lark: "飞书机器人",
  wecom: "企业微信",
  slack: "Slack",
  generic: "通用 Webhook",
  backup: "加密备份推送",
};

export const QUOTA_THRESHOLDS = [80, 95, 100] as const;
export type QuotaThreshold = (typeof QUOTA_THRESHOLDS)[number];
