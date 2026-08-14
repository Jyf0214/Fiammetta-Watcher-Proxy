"use client";

import { memo } from "react";

import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import ClaudeColor from "@lobehub/icons/es/Claude/components/Color";
import GeminiColor from "@lobehub/icons/es/Gemini/components/Color";
import GemmaColor from "@lobehub/icons/es/Gemma/components/Color";
import DeepSeekColor from "@lobehub/icons/es/DeepSeek/components/Color";
import QwenColor from "@lobehub/icons/es/Qwen/components/Color";
import MistralColor from "@lobehub/icons/es/Mistral/components/Color";
import DalleColor from "@lobehub/icons/es/Dalle/components/Color";
import CohereColor from "@lobehub/icons/es/Cohere/components/Color";
import KimiColor from "@lobehub/icons/es/Kimi/components/Color";
import NvidiaColor from "@lobehub/icons/es/Nvidia/components/Color";
import MetaColor from "@lobehub/icons/es/Meta/components/Color";
import LLaVAColor from "@lobehub/icons/es/LLaVA/components/Color";
import ChatGLMColor from "@lobehub/icons/es/ChatGLM/components/Color";
import GLMVColor from "@lobehub/icons/es/GLMV/components/Color";
import CodeGeeXColor from "@lobehub/icons/es/CodeGeeX/components/Color";
import ZAIMono from "@lobehub/icons/es/ZAI/components/Mono";
import DoubaoColor from "@lobehub/icons/es/Doubao/components/Color";
import HunyuanColor from "@lobehub/icons/es/Hunyuan/components/Color";
import JimengColor from "@lobehub/icons/es/Jimeng/components/Color";
import KlingColor from "@lobehub/icons/es/Kling/components/Color";
import KolorsColor from "@lobehub/icons/es/Kolors/components/Color";
import BaiduCloudColor from "@lobehub/icons/es/BaiduCloud/components/Color";
import WenxinColor from "@lobehub/icons/es/Wenxin/components/Color";
import FireworksColor from "@lobehub/icons/es/Fireworks/components/Color";
import InternLMColor from "@lobehub/icons/es/InternLM/components/Color";
import NousResearchMono from "@lobehub/icons/es/NousResearch/components/Mono";
import SoraColor from "@lobehub/icons/es/Sora/components/Color";
import StabilityColor from "@lobehub/icons/es/Stability/components/Color";
import SparkColor from "@lobehub/icons/es/Spark/components/Color";
import NovaColor from "@lobehub/icons/es/Nova/components/Color";
import VertexAIColor from "@lobehub/icons/es/VertexAI/components/Color";
import DeepMindColor from "@lobehub/icons/es/DeepMind/components/Color";
import NanoBananaColor from "@lobehub/icons/es/NanoBanana/components/Color";
import AwsColor from "@lobehub/icons/es/Aws/components/Color";
import IBMMono from "@lobehub/icons/es/IBM/components/Mono";
import TIColor from "@lobehub/icons/es/TII/components/Color";
import RwkvColor from "@lobehub/icons/es/Rwkv/components/Color";
import SkyworkColor from "@lobehub/icons/es/Skywork/components/Color";
import ArceeColor from "@lobehub/icons/es/Arcee/components/Color";
import MorphColor from "@lobehub/icons/es/Morph/components/Color";
import Ai2Color from "@lobehub/icons/es/Ai2/components/Color";
import OpenChatColor from "@lobehub/icons/es/OpenChat/components/Color";
import AyaColor from "@lobehub/icons/es/Aya/components/Color";
import DbrxColor from "@lobehub/icons/es/Dbrx/components/Color";
import OpenRouterColor from "@lobehub/icons/es/OpenRouter/components/Color";
import CogViewColor from "@lobehub/icons/es/CogView/components/Color";
import UdioColor from "@lobehub/icons/es/Udio/components/Color";
import VoyageColor from "@lobehub/icons/es/Voyage/components/Color";
import MenloColor from "@lobehub/icons/es/Menlo/components/Color";
import LongCatColor from "@lobehub/icons/es/LongCat/components/Color";
import KwaipilotColor from "@lobehub/icons/es/Kwaipilot/components/Color";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono";
import OllamaMono from "@lobehub/icons/es/Ollama/components/Mono";
import StepfunMono from "@lobehub/icons/es/Stepfun/components/Mono";
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import JinaMono from "@lobehub/icons/es/Jina/components/Mono";
import BAAIMono from "@lobehub/icons/es/BAAI/components/Mono";
import FluxMono from "@lobehub/icons/es/Flux/components/Mono";
import SunoMono from "@lobehub/icons/es/Suno/components/Mono";
import V0Mono from "@lobehub/icons/es/V0/components/Mono";
import PhindMono from "@lobehub/icons/es/Phind/components/Mono";
import DolphinMono from "@lobehub/icons/es/Dolphin/components/Mono";
import XiaomiMiMoMono from "@lobehub/icons/es/XiaomiMiMo/components/Mono";
import AceMono from "@lobehub/icons/es/Ace/components/Mono";
import InceptionMono from "@lobehub/icons/es/Inception/components/Mono";
import RelaceMono from "@lobehub/icons/es/Relace/components/Mono";

type IconComp = React.FC<{ size?: number }>;

interface ModelEntry {
  Icon: IconComp;
  color?: string;
}

// 模型 ID 前缀 → 品牌图标映射（与品牌库 modelConfig 对齐）
// 有 Color 组件用 Color，没有的用 Mono + 品牌色背景
const MODEL_PREFIX_MAP: { prefix: string; entry: ModelEntry }[] = [
  // OpenAI 系列
  { prefix: "gpt-3", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "gpt-4", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "gpt-5", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "gpt-oss", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "o1", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "o3", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "o4", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "chatgpt", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "text-embedding", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "text-davinci", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "whisper", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "tts", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "codex", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "omni-moderation", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "computer-use", entry: { Icon: OpenAIMono as IconComp } },
  { prefix: "sora", entry: { Icon: SoraColor as IconComp } },
  { prefix: "dall-e", entry: { Icon: DalleColor as IconComp } },
  { prefix: "dalle", entry: { Icon: DalleColor as IconComp } },
  { prefix: "openai", entry: { Icon: OpenAIMono as IconComp } },
  // Claude / Anthropic
  { prefix: "claude", entry: { Icon: ClaudeColor as IconComp } },
  { prefix: "anthropic", entry: { Icon: AnthropicMono as IconComp } },
  // Google 系列
  { prefix: "gemini-3.1-flash-image", entry: { Icon: NanoBananaColor as IconComp } },
  { prefix: "gemini-3-pro-image", entry: { Icon: NanoBananaColor as IconComp } },
  { prefix: "gemini", entry: { Icon: GeminiColor as IconComp } },
  { prefix: "gemma", entry: { Icon: GemmaColor as IconComp } },
  { prefix: "imagen", entry: { Icon: DeepMindColor as IconComp } },
  { prefix: "learnlm", entry: { Icon: GeminiColor as IconComp } },
  { prefix: "nano-banana", entry: { Icon: NanoBananaColor as IconComp } },
  { prefix: "nanobanana", entry: { Icon: NanoBananaColor as IconComp } },
  // DeepSeek
  { prefix: "deepseek", entry: { Icon: DeepSeekColor as IconComp } },
  // Qwen
  { prefix: "qwen", entry: { Icon: QwenColor as IconComp } },
  { prefix: "qwq", entry: { Icon: QwenColor as IconComp } },
  { prefix: "qvq", entry: { Icon: QwenColor as IconComp } },
  { prefix: "tongyi", entry: { Icon: QwenColor as IconComp } },
  { prefix: "gte-rerank", entry: { Icon: QwenColor as IconComp } },
  // Mistral
  { prefix: "mistral", entry: { Icon: MistralColor as IconComp } },
  { prefix: "mixtral", entry: { Icon: MistralColor as IconComp } },
  { prefix: "codestral", entry: { Icon: MistralColor as IconComp } },
  { prefix: "mathstral", entry: { Icon: MistralColor as IconComp } },
  { prefix: "pixtral", entry: { Icon: MistralColor as IconComp } },
  { prefix: "ministral", entry: { Icon: MistralColor as IconComp } },
  { prefix: "magistral", entry: { Icon: MistralColor as IconComp } },
  { prefix: "devstral", entry: { Icon: MistralColor as IconComp } },
  { prefix: "voxtral", entry: { Icon: MistralColor as IconComp } },
  // Kimi / Moonshot
  { prefix: "kimi", entry: { Icon: KimiColor as IconComp } },
  { prefix: "moonshot", entry: { Icon: KimiColor as IconComp } },
  // Nvidia
  { prefix: "nemotron", entry: { Icon: NvidiaColor as IconComp } },
  { prefix: "nvidia", entry: { Icon: NvidiaColor as IconComp } },
  { prefix: "nv-", entry: { Icon: NvidiaColor as IconComp } },
  { prefix: "neva-", entry: { Icon: NvidiaColor as IconComp } },
  // Meta / Llama
  { prefix: "llama", entry: { Icon: MetaColor as IconComp } },
  { prefix: "llava", entry: { Icon: LLaVAColor as IconComp } },
  // Grok
  { prefix: "grok", entry: { Icon: GrokMono as IconComp } },
  // Cohere
  { prefix: "command", entry: { Icon: CohereColor as IconComp } },
  { prefix: "aya", entry: { Icon: AyaColor as IconComp } },
  // GLM / ChatGLM
  { prefix: "glm-5", entry: { Icon: ZAIMono as IconComp } },
  { prefix: "glm-4", entry: { Icon: ZAIMono as IconComp } },
  { prefix: "glm4", entry: { Icon: ZAIMono as IconComp } },
  { prefix: "glm-", entry: { Icon: ChatGLMColor as IconComp } },
  { prefix: "chatglm", entry: { Icon: ChatGLMColor as IconComp } },
  { prefix: "codegeex", entry: { Icon: CodeGeeXColor as IconComp } },
  { prefix: "glm", entry: { Icon: GLMVColor as IconComp } },
  // Doubao / ByteDance
  { prefix: "doubao", entry: { Icon: DoubaoColor as IconComp } },
  { prefix: "ep-", entry: { Icon: DoubaoColor as IconComp } },
  // Hunyuan
  { prefix: "hunyuan", entry: { Icon: HunyuanColor as IconComp } },
  { prefix: "hy3", entry: { Icon: HunyuanColor as IconComp } },
  // Jimeng / CogView
  { prefix: "jimeng", entry: { Icon: JimengColor as IconComp } },
  { prefix: "seedream", entry: { Icon: JimengColor as IconComp } },
  { prefix: "seedance", entry: { Icon: JimengColor as IconComp } },
  { prefix: "cogview", entry: { Icon: CogViewColor as IconComp } },
  // Kling
  { prefix: "kling", entry: { Icon: KlingColor as IconComp } },
  // Kolors
  { prefix: "kolors", entry: { Icon: KolorsColor as IconComp } },
  // Baidu
  { prefix: "baidu", entry: { Icon: BaiduCloudColor as IconComp } },
  { prefix: "qianfan", entry: { Icon: BaiduCloudColor as IconComp } },
  // Wenxin / ERNIE
  { prefix: "ernie", entry: { Icon: WenxinColor as IconComp } },
  { prefix: "irag", entry: { Icon: WenxinColor as IconComp } },
  // Jina
  { prefix: "jina", entry: { Icon: JinaMono as IconComp } },
  // BAAI / BGE
  { prefix: "bge-", entry: { Icon: BAAIMono as IconComp } },
  { prefix: "baai", entry: { Icon: BAAIMono as IconComp } },
  { prefix: "touchd", entry: { Icon: BAAIMono as IconComp } },
  { prefix: "robobrain", entry: { Icon: BAAIMono as IconComp } },
  // Fireworks
  { prefix: "accounts/fireworks", entry: { Icon: FireworksColor as IconComp } },
  // InternLM
  { prefix: "internlm", entry: { Icon: InternLMColor as IconComp } },
  { prefix: "internvl", entry: { Icon: InternLMColor as IconComp } },
  // NousResearch
  { prefix: "deephermes", entry: { Icon: NousResearchMono as IconComp } },
  { prefix: "hermes", entry: { Icon: NousResearchMono as IconComp } },
  { prefix: "genstruct", entry: { Icon: NousResearchMono as IconComp } },
  { prefix: "minos", entry: { Icon: NousResearchMono as IconComp } },
  // Minimax
  { prefix: "minimax", entry: { Icon: MistralColor as IconComp } },
  { prefix: "abab", entry: { Icon: MistralColor as IconComp } },
  // Perplexity
  { prefix: "pplx", entry: { Icon: OpenRouterColor as IconComp } },
  { prefix: "sonar", entry: { Icon: OpenRouterColor as IconComp } },
  // Yi
  { prefix: "yi-", entry: { Icon: QwenColor as IconComp } },
  // Stepfun
  { prefix: "step", entry: { Icon: StepfunMono as IconComp } },
  // Stability / Flux
  { prefix: "stable", entry: { Icon: StabilityColor as IconComp } },
  { prefix: "flux", entry: { Icon: FluxMono as IconComp } },
  // Suno / Udio
  { prefix: "suno", entry: { Icon: SunoMono as IconComp } },
  { prefix: "udio", entry: { Icon: UdioColor as IconComp } },
  // Spark
  { prefix: "spark", entry: { Icon: SparkColor as IconComp } },
  // Aws / Titan
  { prefix: "titan", entry: { Icon: AwsColor as IconComp } },
  // IBM / Granite
  { prefix: "ibm", entry: { Icon: IBMMono as IconComp } },
  { prefix: "granite", entry: { Icon: IBMMono as IconComp } },
  // TII / Falcon
  { prefix: "falcon", entry: { Icon: TIColor as IconComp } },
  // Rwkv
  { prefix: "rwkv", entry: { Icon: RwkvColor as IconComp } },
  { prefix: "eagle-", entry: { Icon: RwkvColor as IconComp } },
  // Skywork
  { prefix: "skywork", entry: { Icon: SkyworkColor as IconComp } },
  // Arcee
  { prefix: "trinity-", entry: { Icon: ArceeColor as IconComp } },
  { prefix: "arcee", entry: { Icon: ArceeColor as IconComp } },
  // Morph
  { prefix: "morph-", entry: { Icon: MorphColor as IconComp } },
  // Ai2 / OLMo
  { prefix: "olmo-", entry: { Icon: Ai2Color as IconComp } },
  // Inception / Mercury
  { prefix: "mercury", entry: { Icon: InceptionMono as IconComp } },
  // OpenChat
  { prefix: "openchat", entry: { Icon: OpenChatColor as IconComp } },
  // Dbrx
  { prefix: "dbrx", entry: { Icon: DbrxColor as IconComp } },
  // OpenRouter
  { prefix: "openrouter", entry: { Icon: OpenRouterColor as IconComp } },
  // Relace
  { prefix: "relace-", entry: { Icon: RelaceMono as IconComp } },
  // Nova
  { prefix: "nova-", entry: { Icon: NovaColor as IconComp } },
  // VertexAI / Veo
  { prefix: "veo", entry: { Icon: VertexAIColor as IconComp } },
  // Voyage
  { prefix: "voyage", entry: { Icon: VoyageColor as IconComp } },
  // Menlo
  { prefix: "menlo", entry: { Icon: MenloColor as IconComp } },
  { prefix: "jan-nano", entry: { Icon: MenloColor as IconComp } },
  // LongCat
  { prefix: "longcat", entry: { Icon: LongCatColor as IconComp } },
  // Kwaipilot
  { prefix: "kat-", entry: { Icon: KwaipilotColor as IconComp } },
  // XiaomiMiMo
  { prefix: "mimo-", entry: { Icon: XiaomiMiMoMono as IconComp } },
  // Phind
  { prefix: "phind", entry: { Icon: PhindMono as IconComp } },
  // Dolphin
  { prefix: "dolphin", entry: { Icon: DolphinMono as IconComp } },
  // V0
  { prefix: "v0", entry: { Icon: V0Mono as IconComp } },
  // Groq
  { prefix: "groq", entry: { Icon: GroqMono as IconComp, color: "#F55036" } },
  // Ollama
  { prefix: "ollama", entry: { Icon: OllamaMono as IconComp } },
  // DeepCogito
  { prefix: "deepcogito", entry: { Icon: DeepSeekColor as IconComp } },
  { prefix: "cogito", entry: { Icon: DeepSeekColor as IconComp } },
  // Ace
  { prefix: "ace-step", entry: { Icon: AceMono as IconComp } },
  // 360
  { prefix: "360gpt", entry: { Icon: QwenColor as IconComp } },
  { prefix: "360zhinao", entry: { Icon: QwenColor as IconComp } },
  // LG
  { prefix: "exaone", entry: { Icon: QwenColor as IconComp } },
  { prefix: "lgai", entry: { Icon: QwenColor as IconComp } },
  // Bilibili
  { prefix: "bilibili", entry: { Icon: QwenColor as IconComp } },
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
