"use client";

import { memo } from "react";

import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import ClaudeMono from "@lobehub/icons/es/Claude/components/Mono";
import GeminiMono from "@lobehub/icons/es/Gemini/components/Mono";
import DeepSeekMono from "@lobehub/icons/es/DeepSeek/components/Mono";
import QwenMono from "@lobehub/icons/es/Qwen/components/Mono";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono";
import MistralMono from "@lobehub/icons/es/Mistral/components/Mono";
import DalleMono from "@lobehub/icons/es/Dalle/components/Mono";
import OllamaMono from "@lobehub/icons/es/Ollama/components/Mono";
import CohereMono from "@lobehub/icons/es/Cohere/components/Mono";

type IconComp = React.FC<{ size?: number }>;

const MODEL_PREFIX_MAP: { prefix: string; Icon: IconComp }[] = [
  { prefix: "gpt-", Icon: OpenAIMono as IconComp },
  { prefix: "o1", Icon: OpenAIMono as IconComp },
  { prefix: "o3", Icon: OpenAIMono as IconComp },
  { prefix: "o4", Icon: OpenAIMono as IconComp },
  { prefix: "chatgpt", Icon: OpenAIMono as IconComp },
  { prefix: "text-embedding", Icon: OpenAIMono as IconComp },
  { prefix: "text-davinci", Icon: OpenAIMono as IconComp },
  { prefix: "dall-e", Icon: DalleMono as IconComp },
  { prefix: "whisper", Icon: OpenAIMono as IconComp },
  { prefix: "tts", Icon: OpenAIMono as IconComp },
  { prefix: "claude", Icon: ClaudeMono as IconComp },
  { prefix: "gemini", Icon: GeminiMono as IconComp },
  { prefix: "deepseek", Icon: DeepSeekMono as IconComp },
  { prefix: "qwen", Icon: QwenMono as IconComp },
  { prefix: "grok-", Icon: GrokMono as IconComp },
  { prefix: "mistral", Icon: MistralMono as IconComp },
  { prefix: "mixtral", Icon: MistralMono as IconComp },
  { prefix: "codestral", Icon: MistralMono as IconComp },
  { prefix: "llama", Icon: OllamaMono as IconComp },
  { prefix: "command", Icon: CohereMono as IconComp },
];

/** 模型图标 — 根据模型 ID 前缀匹配品牌 SVG，未匹配时回退到色块 */
export const ModelIcon = memo(function ModelIcon({
  modelId,
  size = "md",
}: {
  modelId: string;
  size?: "sm" | "md";
}) {
  const px = size === "sm" ? 20 : 32;
  const lower = modelId.toLowerCase();
  const match = MODEL_PREFIX_MAP.find((m) => lower.startsWith(m.prefix));

  if (match) {
    const Icon = match.Icon;
    return (
      <div
        className="shrink-0 flex items-center justify-center text-zinc-700 dark:text-zinc-300"
        style={{ width: px, height: px }}
      >
        <Icon size={Math.round(px * 0.7)} />
      </div>
    );
  }

  return (
    <div
      className="shrink-0 flex items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-400 dark:text-zinc-500 text-xs font-bold"
      style={{ width: px, height: px }}
    >
      {modelId.slice(0, 2).toUpperCase()}
    </div>
  );
});
