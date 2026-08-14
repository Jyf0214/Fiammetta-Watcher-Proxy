"use client";

import { memo } from "react";

import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import AzureMono from "@lobehub/icons/es/Azure/components/Mono";
import GoogleMono from "@lobehub/icons/es/Google/components/Mono";
import DeepSeekMono from "@lobehub/icons/es/DeepSeek/components/Mono";
import MistralMono from "@lobehub/icons/es/Mistral/components/Mono";
import QwenMono from "@lobehub/icons/es/Qwen/components/Mono";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono";
import OllamaMono from "@lobehub/icons/es/Ollama/components/Mono";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono";
import CohereMono from "@lobehub/icons/es/Cohere/components/Mono";
import MoonshotMono from "@lobehub/icons/es/Moonshot/components/Mono";
import ZhipuMono from "@lobehub/icons/es/Zhipu/components/Mono";
import MinimaxMono from "@lobehub/icons/es/Minimax/components/Mono";
import BaichuanMono from "@lobehub/icons/es/Baichuan/components/Mono";
import YiMono from "@lobehub/icons/es/Yi/components/Mono";
import StepfunMono from "@lobehub/icons/es/Stepfun/components/Mono";
import PerplexityMono from "@lobehub/icons/es/Perplexity/components/Mono";
import XAIMono from "@lobehub/icons/es/XAI/components/Mono";

type IconComp = React.FC<{ size?: number }>;

const BRAND_MAP: Record<string, IconComp> = {
  openai: OpenAIMono as IconComp,
  anthropic: AnthropicMono as IconComp,
  azure: AzureMono as IconComp,
  google: GoogleMono as IconComp,
  deepseek: DeepSeekMono as IconComp,
  mistral: MistralMono as IconComp,
  qwen: QwenMono as IconComp,
  xai: XAIMono as IconComp,
  grok: GrokMono as IconComp,
  ollama: OllamaMono as IconComp,
  groq: GroqMono as IconComp,
  cohere: CohereMono as IconComp,
  moonshot: MoonshotMono as IconComp,
  zhipu: ZhipuMono as IconComp,
  minimax: MinimaxMono as IconComp,
  baichuan: BaichuanMono as IconComp,
  yi: YiMono as IconComp,
  stepfun: StepfunMono as IconComp,
  perplexity: PerplexityMono as IconComp,
};

/** 平台品牌图标 — 已知 type 用品牌 SVG，未知 type 返回 null */
export const BrandIcon = memo(function BrandIcon({
  type,
  size = 32,
}: {
  type: string;
  size?: number;
}) {
  const Icon = BRAND_MAP[type];
  if (!Icon) return null;

  return (
    <div
      className="shrink-0 flex items-center justify-center text-zinc-700 dark:text-zinc-300"
      style={{ width: size, height: size }}
    >
      <Icon size={Math.round(size * 0.7)} />
    </div>
  );
});

export { BRAND_MAP };
