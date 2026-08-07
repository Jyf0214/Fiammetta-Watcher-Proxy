"use client";

import { cn } from "@/lib/ui";

/**
 * 模型图标 — 按模型 ID 前缀匹配品牌色渐变 + 白色粗体字（对照参考 ModelIcon）
 * 已知品牌用专属配色，未知模型按 ID 哈希从渐变池中取色回退
 */
interface BrandDef {
  label: string;
  gradient: string;
}

const BRAND_PATTERNS: { pattern: RegExp; brand: BrandDef }[] = [
  // OpenAI
  { pattern: /^(gpt|chatgpt|o1|o3|text-|dall-e|whisper|gpt-image)/i, brand: { label: "G", gradient: "bg-gradient-to-br from-emerald-400 to-teal-600" } },
  // Anthropic
  { pattern: /^claude/i, brand: { label: "C", gradient: "bg-gradient-to-br from-orange-400 to-amber-600" } },
  // Google Gemini
  { pattern: /^gemini/i, brand: { label: "G", gradient: "bg-gradient-to-br from-blue-400 to-indigo-600" } },
  // DeepSeek
  { pattern: /^deepseek/i, brand: { label: "D", gradient: "bg-gradient-to-br from-blue-500 to-indigo-700" } },
  // 通义千问
  { pattern: /^(qwen|dashscope|ali)/i, brand: { label: "Q", gradient: "bg-gradient-to-br from-violet-500 to-purple-700" } },
  // Meta Llama
  { pattern: /^llama/i, brand: { label: "L", gradient: "bg-gradient-to-br from-indigo-400 to-blue-600" } },
  // Mistral
  { pattern: /^mistral/i, brand: { label: "M", gradient: "bg-gradient-to-br from-orange-500 to-red-600" } },
  // Moonshot Kimi
  { pattern: /^(moonshot|kimi)/i, brand: { label: "K", gradient: "bg-gradient-to-br from-zinc-600 to-zinc-900" } },
  // 智谱 GLM
  { pattern: /^glm/i, brand: { label: "Z", gradient: "bg-gradient-to-br from-sky-400 to-blue-600" } },
  // xAI Grok
  { pattern: /^grok/i, brand: { label: "X", gradient: "bg-gradient-to-br from-zinc-700 to-black" } },
  // Perplexity
  { pattern: /^perplexity/i, brand: { label: "P", gradient: "bg-gradient-to-br from-teal-400 to-emerald-600" } },
  // 豆包
  { pattern: /^(doubao|volc)/i, brand: { label: "DB", gradient: "bg-gradient-to-br from-red-400 to-rose-600" } },
  // MiniMax
  { pattern: /^minimax/i, brand: { label: "M", gradient: "bg-gradient-to-br from-fuchsia-500 to-purple-700" } },
  // Cohere
  { pattern: /^cohere/i, brand: { label: "C", gradient: "bg-gradient-to-br from-amber-400 to-yellow-600" } },
  // Groq
  { pattern: /^groq/i, brand: { label: "G", gradient: "bg-gradient-to-br from-orange-400 to-amber-500" } },
  // 百川
  { pattern: /^baichuan/i, brand: { label: "B", gradient: "bg-gradient-to-br from-cyan-400 to-sky-600" } },
  // 文心
  { pattern: /^(ernie|wenxin)/i, brand: { label: "E", gradient: "bg-gradient-to-br from-blue-400 to-blue-700" } },
  // 零一万物
  { pattern: /^yi-/i, brand: { label: "Y", gradient: "bg-gradient-to-br from-slate-500 to-slate-700" } },
  // 阶跃星辰
  { pattern: /^step/i, brand: { label: "S", gradient: "bg-gradient-to-br from-amber-500 to-orange-700" } },
];

const FALLBACK_GRADIENTS = [
  "bg-gradient-to-br from-blue-500 to-indigo-600",
  "bg-gradient-to-br from-emerald-500 to-teal-600",
  "bg-gradient-to-br from-violet-500 to-purple-600",
  "bg-gradient-to-br from-orange-500 to-amber-600",
  "bg-gradient-to-br from-rose-500 to-pink-600",
  "bg-gradient-to-br from-cyan-500 to-sky-600",
];

function resolveBrand(modelId: string): BrandDef {
  const id = modelId.trim();
  for (const { pattern, brand } of BRAND_PATTERNS) {
    if (pattern.test(id)) return brand;
  }
  // 未知模型：按 ID 哈希取固定渐变，避免同页内同前缀模型颜色跳动
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const gradient = FALLBACK_GRADIENTS[Math.abs(hash) % FALLBACK_GRADIENTS.length];
  const parts = id.split("/");
  const brand = (parts.length > 1 ? parts[0] : id.split("-")[0]).slice(0, 2).toUpperCase();
  return { label: brand || "?", gradient };
}

export function ModelIcon({ modelId, size = "md" }: { modelId: string; size?: "sm" | "md" }) {
  const brand = resolveBrand(modelId);
  const box = size === "sm" ? "w-6 h-6 rounded-md text-[9px]" : "w-8 h-8 rounded-lg text-[11px]";
  return (
    <div
      className={cn(
        "shrink-0 flex items-center justify-center font-bold text-white select-none",
        box,
        brand.gradient
      )}
    >
      {brand.label}
    </div>
  );
}
