import { Cpu, MessageSquare, Image, Mic, Box, Layers } from "lucide-react";
import type { Platform } from "@/components/platform/PlatformList";

// ---------- 密钥 ----------

export interface NamedApiKey {
  name: string;
  key: string;
  whitelisted?: boolean;
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
      arr.forEach((item: { name?: string; key: string; whitelisted?: boolean }) => {
        if (item && typeof item.key === "string" && item.key.trim()) {
          parsed.push({
            name: item.name || `${namePrefix}${parsed.length + 1}`,
            key: item.key,
            whitelisted: !!item.whitelisted,
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
