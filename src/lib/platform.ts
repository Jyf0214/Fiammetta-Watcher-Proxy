import { Cpu, MessageSquare, Image, Mic, Box, Layers } from "lucide-react";
import type { Platform } from "@/components/platform/PlatformList";

// ---------- 密钥 ----------

export interface NamedApiKey {
  name: string;
  key: string;
  whitelisted?: boolean;
}

/** 解析平台密钥列表（兼容 JSON 字符串与已解析数组两种形态） */
export function parseNamedKeys(platform: Platform | null): NamedApiKey[] {
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
            name: item.name || `密钥${parsed.length + 1}`,
            key: item.key,
            whitelisted: !!item.whitelisted,
          });
        }
      });
    } else {
      arr.forEach((key: unknown, idx: number) => {
        if (typeof key === "string" && key.trim()) {
          parsed.push({ name: `密钥${idx + 1}`, key });
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

export const MODEL_TYPE_CONFIG: Record<string, { icon: typeof Cpu; label: string; color: string; bg: string }> = {
  chat:       { icon: MessageSquare, label: "文字", color: "text-blue-500",   bg: "bg-blue-50 dark:bg-blue-900/30" },
  embedding:  { icon: Layers,       label: "向量", color: "text-cyan-500",   bg: "bg-cyan-50 dark:bg-cyan-900/30" },
  image:      { icon: Image,        label: "图片", color: "text-purple-500", bg: "bg-purple-50 dark:bg-purple-900/30" },
  audio:      { icon: Mic,          label: "音频", color: "text-orange-500", bg: "bg-orange-50 dark:bg-orange-900/30" },
  video:      { icon: Box,          label: "视频", color: "text-pink-500",   bg: "bg-pink-50 dark:bg-pink-900/30" },
  moderation: { icon: Cpu,          label: "审核", color: "text-red-500",    bg: "bg-red-50 dark:bg-red-900/30" },
};

/** 根据模型 ID 猜测品牌首字母 */
export function getModelBrand(modelId: string): string {
  const parts = modelId.split("/");
  const brand = parts.length > 1 ? parts[0] : modelId.split("-")[0];
  return brand.slice(0, 2).toUpperCase();
}

// ---------- 表单 ----------

/** Base URL 快捷填充胶囊 */
export const BASE_URL_PRESETS = [
  "https://api.openai.com/v1",
  "https://api.anthropic.com/v1",
  "https://generativelanguage.googleapis.com/v1beta",
  "https://api.deepseek.com/v1",
];

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
