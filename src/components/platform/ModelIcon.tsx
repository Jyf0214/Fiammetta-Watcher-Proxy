"use client";

import { memo } from "react";

import ClaudeColor from "@lobehub/icons/es/Claude/components/Color";
import GeminiColor from "@lobehub/icons/es/Gemini/components/Color";
import DeepSeekColor from "@lobehub/icons/es/DeepSeek/components/Color";
import QwenColor from "@lobehub/icons/es/Qwen/components/Color";
import MistralColor from "@lobehub/icons/es/Mistral/components/Color";
import DalleColor from "@lobehub/icons/es/Dalle/components/Color";
import CohereColor from "@lobehub/icons/es/Cohere/components/Color";
import KimiColor from "@lobehub/icons/es/Kimi/components/Color";
import NvidiaColor from "@lobehub/icons/es/Nvidia/components/Color";
import MetaColor from "@lobehub/icons/es/Meta/components/Color";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono";
import OllamaMono from "@lobehub/icons/es/Ollama/components/Mono";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono";

type IconComp = React.FC<{ size?: number }>;

interface ModelEntry {
  Icon: IconComp;
  color?: string;
}

const MODEL_PREFIX_MAP: { prefix: string; entry: ModelEntry }[] = [
  { prefix: "gpt-", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "o1", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "o3", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "o4", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "chatgpt", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "text-embedding", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "text-davinci", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "dall-e", entry: { Icon: DalleColor as IconComp } },
  { prefix: "whisper", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "tts", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "claude", entry: { Icon: ClaudeColor as IconComp } },
  { prefix: "gemini", entry: { Icon: GeminiColor as IconComp } },
  { prefix: "deepseek", entry: { Icon: DeepSeekColor as IconComp } },
  { prefix: "qwen", entry: { Icon: QwenColor as IconComp } },
  { prefix: "grok-", entry: { Icon: GrokMono as IconComp } },
  { prefix: "mistral", entry: { Icon: MistralColor as IconComp } },
  { prefix: "mixtral", entry: { Icon: MistralColor as IconComp } },
  { prefix: "codestral", entry: { Icon: MistralColor as IconComp } },
  { prefix: "llama", entry: { Icon: MetaColor as IconComp } },
  { prefix: "meta-", entry: { Icon: MetaColor as IconComp } },
  { prefix: "command", entry: { Icon: CohereColor as IconComp } },
  { prefix: "kimi", entry: { Icon: KimiColor as IconComp } },
  { prefix: "moonshot", entry: { Icon: KimiColor as IconComp } },
  { prefix: "nemotron", entry: { Icon: NvidiaColor as IconComp } },
  { prefix: "nvidia", entry: { Icon: NvidiaColor as IconComp } },
  { prefix: "ollama", entry: { Icon: OllamaMono as IconComp } },
  { prefix: "groq", entry: { Icon: GroqMono as IconComp, color: "#F55036" } },
];

/** 模型图标 — 根据模型 ID 前缀匹配品牌彩色 SVG，未匹配时回退到色块 */
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
    const { Icon, color } = match.entry;
    const iconSize = Math.round(px * 0.7);

    if (color) {
      return (
        <div
          className="shrink-0 flex items-center justify-center rounded-lg"
          style={{ width: px, height: px, backgroundColor: color }}
        >
          <Icon size={iconSize} />
        </div>
      );
    }

    return (
      <div
        className="shrink-0 flex items-center justify-center"
        style={{ width: px, height: px }}
      >
        <Icon size={iconSize} />
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
