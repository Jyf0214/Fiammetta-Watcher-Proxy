import { Cpu, MessageSquare, Image, Mic, Box, Layers } from "lucide-react";
import type { Platform } from "@/components/platform/PlatformList";

// ---------- 密钥 ----------

export interface NamedApiKey {
  name: string;
  key: string;
  whitelisted?: boolean;
  enabled?: boolean;
  errorCount?: number;
  /** 密钥级代理绑定 URL 列表（最多 2 个） */
  proxyUrls?: string[];
  /** 严格绑定模式：true=绑定代理不可用时 502，false=回退平台级（默认 true） */
  proxyStrict?: boolean;
}

/** 解析平台密钥列表（兼容 JSON 字符串与已解析数组两种形态）；namePrefix 为默认密钥名前缀 */
export function parseNamedKeys(platform: Platform | null, namePrefix = "Key"): NamedApiKey[] {
  const parsed: NamedApiKey[] = [];
  const raw = platform?.apiKeys;
  if (!raw) return parsed;
  let arr: unknown = null;
  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) arr = v;
    } catch { /* ignore */ }
  }
  if (Array.isArray(arr) && arr.length > 0) {
    if (typeof arr[0] === "object" && arr[0] !== null && "key" in arr[0]) {
      arr.forEach((item: Record<string, unknown>) => {
        if (item && typeof item.key === "string" && (item.key as string).trim()) {
          const proxyUrls = Array.isArray(item.proxyUrls)
            ? (item.proxyUrls as unknown[]).filter((u): u is string => typeof u === "string").slice(0, 2)
            : undefined;
          parsed.push({
            name: (typeof item.name === "string" && item.name) || `${namePrefix}${parsed.length + 1}`,
            key: (item.key as string).trim(),
            whitelisted: item.whitelisted === true,
            enabled: item.enabled !== false,
            errorCount: typeof item.errorCount === "number" ? item.errorCount : 0,
            proxyUrls: proxyUrls && proxyUrls.length > 0 ? proxyUrls : undefined,
            proxyStrict: item.proxyStrict === false ? false : undefined,
          });
        }
      });
    } else {
      arr.forEach((key: unknown, idx: number) => {
        if (typeof key === "string" && key.trim()) {
          parsed.push({ name: `${namePrefix}${idx + 1}`, key });
        }
      });
    }
  }
  return parsed;
}

// ---------- 模型 ----------

export interface ModelItem {
  id: string;
  modelId: string;
  ownedBy: string | null;
  source: string;
  type: string;
  enabled: boolean;
  fetchedAt: string;
}

export const MODEL_TYPE_CONFIG: Record<string, { icon: typeof Cpu; labelKey: string; color: string; bg: string }> = {
  chat:       { icon: MessageSquare, labelKey: "typeChat",       color: "text-zinc-600 dark:text-zinc-400",   bg: "bg-zinc-100 dark:bg-zinc-800" },
  embedding:  { icon: Layers,       labelKey: "typeEmbedding",  color: "text-cyan-500",   bg: "bg-cyan-50 dark:bg-cyan-900/30" },
  image:      { icon: Image,        labelKey: "typeImage",      color: "text-slate-500",  bg: "bg-slate-100 dark:bg-slate-800/50" },
  audio:      { icon: Mic,          labelKey: "typeAudio",      color: "text-orange-500", bg: "bg-orange-50 dark:bg-orange-900/30" },
  video:      { icon: Box,          labelKey: "typeVideo",      color: "text-pink-500",   bg: "bg-pink-50 dark:bg-pink-900/30" },
  moderation: { icon: Cpu,          labelKey: "typeModeration", color: "text-red-500",    bg: "bg-red-50 dark:bg-red-900/30" },
};

// ---------- 表单 ----------

/** forwardHeaders 数组/JSON 字符串 → 每行一个 Header 的文本 */
export function parseForwardHeaders(raw: string | string[] | null | undefined): string {
  if (!raw) return "";
  if (Array.isArray(raw)) return raw.join("\n");
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.join("\n") : raw;
  } catch {
    return raw;
  }
}

// ---------- 自定义请求头（强制覆盖） ----------

/**
 * 将存储的 extraHeaders JSON 字符串转换为文本框展示文本（每行 `Key: Value`）。
 * 解析失败或非对象时返回空字符串。
 */
export function parseExtraHeadersText(raw: string | null | undefined): string {
  if (!raw || raw === "{}") return "";
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";
    return Object.entries(obj)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => `${k}: ${v as string}`)
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * 将文本框（`Key: Value` 每行一个，空行忽略）转换为 extraHeaders JSON 字符串。
 * 无有效行时返回 "{}"。
 */
export function serializeExtraHeaders(text: string | undefined): string {
  if (!text || !text.trim()) return "{}";
  const obj: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!key || !value) continue;
    obj[key] = value;
  }
  return Object.keys(obj).length > 0 ? JSON.stringify(obj) : "{}";
}
