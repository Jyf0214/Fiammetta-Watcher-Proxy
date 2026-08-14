"use client";

import { memo } from "react";

import DeepSeekColor from "@lobehub/icons/es/DeepSeek/components/Color";
import QwenColor from "@lobehub/icons/es/Qwen/components/Color";
import AzureColor from "@lobehub/icons/es/Azure/components/Color";
import GoogleColor from "@lobehub/icons/es/Google/components/Color";
import MistralColor from "@lobehub/icons/es/Mistral/components/Color";
import CohereColor from "@lobehub/icons/es/Cohere/components/Color";
import ZhipuColor from "@lobehub/icons/es/Zhipu/components/Color";
import MinimaxColor from "@lobehub/icons/es/Minimax/components/Color";
import BaichuanColor from "@lobehub/icons/es/Baichuan/components/Color";
import YiColor from "@lobehub/icons/es/Yi/components/Color";
import PerplexityColor from "@lobehub/icons/es/Perplexity/components/Color";
import KimiColor from "@lobehub/icons/es/Kimi/components/Color";
import NvidiaColor from "@lobehub/icons/es/Nvidia/components/Color";
import MetaColor from "@lobehub/icons/es/Meta/components/Color";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono";
import OllamaMono from "@lobehub/icons/es/Ollama/components/Mono";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono";
import MoonshotMono from "@lobehub/icons/es/Moonshot/components/Mono";
import StepfunMono from "@lobehub/icons/es/Stepfun/components/Mono";
import XAIMono from "@lobehub/icons/es/XAI/components/Mono";

type IconComp = React.FC<{ size?: number }>;

interface BrandEntry {
  Icon: IconComp;
  color?: string;
}

const BRAND_MAP: Record<string, BrandEntry> = {
  openai: { Icon: OpenAIMono as IconComp },
  anthropic: { Icon: AnthropicMono as IconComp },
  azure: { Icon: AzureColor as IconComp },
  google: { Icon: GoogleColor as IconComp },
  deepseek: { Icon: DeepSeekColor as IconComp },
  mistral: { Icon: MistralColor as IconComp },
  qwen: { Icon: QwenColor as IconComp },
  xai: { Icon: XAIMono as IconComp },
  grok: { Icon: GrokMono as IconComp },
  ollama: { Icon: OllamaMono as IconComp },
  groq: { Icon: GroqMono as IconComp, color: "#F55036" },
  cohere: { Icon: CohereColor as IconComp },
  moonshot: { Icon: MoonshotMono as IconComp },
  kimi: { Icon: KimiColor as IconComp },
  zhipu: { Icon: ZhipuColor as IconComp },
  minimax: { Icon: MinimaxColor as IconComp },
  baichuan: { Icon: BaichuanColor as IconComp },
  yi: { Icon: YiColor as IconComp },
  stepfun: { Icon: StepfunMono as IconComp },
  perplexity: { Icon: PerplexityColor as IconComp },
  nvidia: { Icon: NvidiaColor as IconComp },
  nemotron: { Icon: NvidiaColor as IconComp },
  meta: { Icon: MetaColor as IconComp },
  llama: { Icon: MetaColor as IconComp },
};

/** 平台品牌图标 — 有彩色用彩色，否则单色+品牌色容器，未知 type 返回 null */
export const BrandIcon = memo(function BrandIcon({
  type,
  size = 32,
}: {
  type: string;
  size?: number;
}) {
  const entry = BRAND_MAP[type];
  if (!entry) return null;

  const { Icon, color } = entry;
  const iconSize = Math.round(size * 0.7);

  if (color) {
    return (
      <div
        className="shrink-0 flex items-center justify-center rounded-lg"
        style={{ width: size, height: size, backgroundColor: color }}
      >
        <Icon size={iconSize} />
      </div>
    );
  }

  return (
    <div
      className="shrink-0 flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <Icon size={iconSize} />
    </div>
  );
});

export { BRAND_MAP };
