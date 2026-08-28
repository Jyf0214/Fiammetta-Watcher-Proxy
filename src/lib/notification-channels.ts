/**
 * 通道模板与渲染
 *
 * 每种 ChannelType 一个 `renderRequest` 工厂：输入 (title, body, event, channel)
 * 输出最终的 (url, headers, body)。`backup` 不走此处 — 由 src/lib/backup.ts 内部
 * 直接处理加密 + POST，避免通知模块感知加密细节。
 *
 * 模板字段含义参考 docs/guide/notifications.md：
 * - Telegram：URL 含 token，POST { chat_id?, text }
 * - Bark：URL 含 key，POST { title, body, group?, level?, icon? }
 * - Server酱：URL 含 sendkey，POST { title, desp }
 * - 飞书：URL 含 verification token，POST { msg_type, content: { text } }
 * - 企业微信：URL 含 key，POST { msgtype, text: { content } }
 * - Slack：incoming webhook URL，POST { text }
 * - Generic：POST { event, title, body, timestamp }
 */

import type { ChannelType, NotificationChannel, NotificationEvent } from "./notification-types";

export interface RenderedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface RenderInput {
  title: string;
  body: string;
  event: NotificationEvent;
  channel: NotificationChannel;
}

const COMMON_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "FWP-Notifier/2.0",
};

function withDefaults(headers: Record<string, string> = {}): Record<string, string> {
  // 通道自定义 header 可覆盖默认值（鉴权场景）
  return { ...COMMON_HEADERS, ...headers };
}

function buildTelegram(input: RenderInput): RenderedRequest {
  const text = input.body ? `${input.title}\n\n${input.body}` : input.title;
  const payload: Record<string, unknown> = { text };
  const chatId = input.channel.options.chatId?.trim();
  if (chatId) payload.chat_id = chatId;
  return {
    url: input.channel.url,
    headers: withDefaults(input.channel.headers),
    body: JSON.stringify(payload),
  };
}

function buildBark(input: RenderInput): RenderedRequest {
  const payload: Record<string, unknown> = {
    title: input.title,
    body: input.body,
  };
  const group = input.channel.options.group?.trim();
  const level = input.channel.options.level?.trim();
  const icon = input.channel.options.icon?.trim();
  if (group) payload.group = group;
  if (level) payload.level = level;
  if (icon) payload.icon = icon;
  return {
    url: input.channel.url,
    headers: withDefaults(input.channel.headers),
    body: JSON.stringify(payload),
  };
}

function buildServerchan(input: RenderInput): RenderedRequest {
  const payload: Record<string, unknown> = {
    title: input.title,
    desp: input.body,
  };
  const short = input.channel.options.short?.trim();
  const channel = input.channel.options.channel?.trim();
  if (short) payload.short = short;
  if (channel) payload.channel = channel;
  return {
    url: input.channel.url,
    headers: withDefaults(input.channel.headers),
    body: JSON.stringify(payload),
  };
}

function buildLark(input: RenderInput): RenderedRequest {
  const text = input.body ? `${input.title}\n${input.body}` : input.title;
  return {
    url: input.channel.url,
    headers: withDefaults(input.channel.headers),
    body: JSON.stringify({
      msg_type: "text",
      content: { text },
    }),
  };
}

function buildWecom(input: RenderInput): RenderedRequest {
  const content = input.body ? `${input.title}\n${input.body}` : input.title;
  return {
    url: input.channel.url,
    headers: withDefaults(input.channel.headers),
    body: JSON.stringify({
      msgtype: "text",
      text: { content },
    }),
  };
}

function buildSlack(input: RenderInput): RenderedRequest {
  const text = input.body ? `*${input.title}*\n${input.body}` : `*${input.title}*`;
  return {
    url: input.channel.url,
    headers: withDefaults(input.channel.headers),
    body: JSON.stringify({ text }),
  };
}

function buildGeneric(input: RenderInput): RenderedRequest {
  return {
    url: input.channel.url,
    headers: withDefaults(input.channel.headers),
    body: JSON.stringify({
      event: input.event,
      title: input.title,
      body: input.body,
      timestamp: Math.floor(Date.now() / 1000),
    }),
  };
}

const RENDERERS: Record<Exclude<ChannelType, "backup">, (i: RenderInput) => RenderedRequest> = {
  telegram: buildTelegram,
  bark: buildBark,
  serverchan: buildServerchan,
  lark: buildLark,
  wecom: buildWecom,
  slack: buildSlack,
  generic: buildGeneric,
};

export function renderNotificationRequest(input: RenderInput): RenderedRequest | null {
  if (input.channel.type === "backup") return null;
  const renderer = RENDERERS[input.channel.type];
  if (!renderer) return null;
  return renderer(input);
}
