"use client";

import { memo } from "react";

import Ai21Mono from "@lobehub/icons/es/Ai21/components/Mono";
import Ai302Color from "@lobehub/icons/es/Ai302/components/Color";
import Ai360Color from "@lobehub/icons/es/Ai360/components/Color";
import AiHubMixColor from "@lobehub/icons/es/AiHubMix/components/Color";
import AkashChatColor from "@lobehub/icons/es/AkashChat/components/Color";
import AntGroupColor from "@lobehub/icons/es/AntGroup/components/Color";
import AnthropicMono from "@lobehub/icons/es/Anthropic/components/Mono";
import AzureColor from "@lobehub/icons/es/Azure/components/Color";
import AzureAIColor from "@lobehub/icons/es/AzureAI/components/Color";
import BaichuanColor from "@lobehub/icons/es/Baichuan/components/Color";
import BailianColor from "@lobehub/icons/es/Bailian/components/Color";
import BedrockColor from "@lobehub/icons/es/Bedrock/components/Color";
import BflMono from "@lobehub/icons/es/Bfl/components/Mono";
import CerebrasColor from "@lobehub/icons/es/Cerebras/components/Color";
import ChatGLMColor from "@lobehub/icons/es/ChatGLM/components/Color";
import CloudflareColor from "@lobehub/icons/es/Cloudflare/components/Color";
import CohereColor from "@lobehub/icons/es/Cohere/components/Color";
import CometAPIColor from "@lobehub/icons/es/CometAPI/components/Color";
import ComfyUIColor from "@lobehub/icons/es/ComfyUI/components/Color";
import DeepSeekColor from "@lobehub/icons/es/DeepSeek/components/Color";
import FalColor from "@lobehub/icons/es/Fal/components/Color";
import FireworksColor from "@lobehub/icons/es/Fireworks/components/Color";
import GiteeAIMono from "@lobehub/icons/es/GiteeAI/components/Mono";
import GithubMono from "@lobehub/icons/es/Github/components/Mono";
import GithubCopilotMono from "@lobehub/icons/es/GithubCopilot/components/Mono";
import GoogleColor from "@lobehub/icons/es/Google/components/Color";
import GrokMono from "@lobehub/icons/es/Grok/components/Mono";
import GroqMono from "@lobehub/icons/es/Groq/components/Mono";
import HigressColor from "@lobehub/icons/es/Higress/components/Color";
import HuggingFaceColor from "@lobehub/icons/es/HuggingFace/components/Color";
import HunyuanColor from "@lobehub/icons/es/Hunyuan/components/Color";
import InfinigenceColor from "@lobehub/icons/es/Infinigence/components/Color";
import InternLMColor from "@lobehub/icons/es/InternLM/components/Color";
import JinaMono from "@lobehub/icons/es/Jina/components/Mono";
import KimiColor from "@lobehub/icons/es/Kimi/components/Color";
import LmStudioMono from "@lobehub/icons/es/LmStudio/components/Mono";
import LongCatColor from "@lobehub/icons/es/LongCat/components/Color";
import MinimaxColor from "@lobehub/icons/es/Minimax/components/Color";
import MistralColor from "@lobehub/icons/es/Mistral/components/Color";
import ModelScopeColor from "@lobehub/icons/es/ModelScope/components/Color";
import MoonshotMono from "@lobehub/icons/es/Moonshot/components/Mono";
import NebiusMono from "@lobehub/icons/es/Nebius/components/Mono";
import NewAPIColor from "@lobehub/icons/es/NewAPI/components/Color";
import NovitaColor from "@lobehub/icons/es/Novita/components/Color";
import NvidiaColor from "@lobehub/icons/es/Nvidia/components/Color";
import OllamaMono from "@lobehub/icons/es/Ollama/components/Mono";
import OpenAIMono from "@lobehub/icons/es/OpenAI/components/Mono";
import OpenCodeMono from "@lobehub/icons/es/OpenCode/components/Mono";
import OpenRouterColor from "@lobehub/icons/es/OpenRouter/components/Color";
import PPIOColor from "@lobehub/icons/es/PPIO/components/Color";
import PerplexityColor from "@lobehub/icons/es/Perplexity/components/Color";
import QiniuColor from "@lobehub/icons/es/Qiniu/components/Color";
import QwenColor from "@lobehub/icons/es/Qwen/components/Color";
import ReplicateMono from "@lobehub/icons/es/Replicate/components/Mono";
import SambaNovaColor from "@lobehub/icons/es/SambaNova/components/Color";
import Search1APIColor from "@lobehub/icons/es/Search1API/components/Color";
import SenseNovaColor from "@lobehub/icons/es/SenseNova/components/Color";
import SiliconCloudColor from "@lobehub/icons/es/SiliconCloud/components/Color";
import SparkColor from "@lobehub/icons/es/Spark/components/Color";
import StepfunMono from "@lobehub/icons/es/Stepfun/components/Mono";
import StraicoColor from "@lobehub/icons/es/Straico/components/Color";
import StreamLakeColor from "@lobehub/icons/es/StreamLake/components/Color";
import TencentCloudColor from "@lobehub/icons/es/TencentCloud/components/Color";
import TogetherColor from "@lobehub/icons/es/Together/components/Color";
import UpstageColor from "@lobehub/icons/es/Upstage/components/Color";
import V0Mono from "@lobehub/icons/es/V0/components/Mono";
import VercelMono from "@lobehub/icons/es/Vercel/components/Mono";
import VertexAIColor from "@lobehub/icons/es/VertexAI/components/Color";
import VllmColor from "@lobehub/icons/es/Vllm/components/Color";
import VolcengineColor from "@lobehub/icons/es/Volcengine/components/Color";
import WenxinColor from "@lobehub/icons/es/Wenxin/components/Color";
import XAIMono from "@lobehub/icons/es/XAI/components/Mono";
import XiaomiMiMoMono from "@lobehub/icons/es/XiaomiMiMo/components/Mono";
import XinferenceColor from "@lobehub/icons/es/Xinference/components/Color";
import ZenMuxMono from "@lobehub/icons/es/ZenMux/components/Mono";
import ZeroOneColor from "@lobehub/icons/es/ZeroOne/components/Color";
import ZhipuColor from "@lobehub/icons/es/Zhipu/components/Color";

type IconComp = React.FC<{ size?: number }>;

interface BrandEntry {
  Icon: IconComp;
  color?: string;
}

/** 预设平台 id → 品牌图标（优先彩色，仅单色时加品牌色容器） */
const PRESET_ICON_MAP: Record<string, BrandEntry> = {
  ai21: { Icon: Ai21Mono as IconComp },
  ai302: { Icon: Ai302Color as IconComp },
  ai360: { Icon: Ai360Color as IconComp },
  aihubmix: { Icon: AiHubMixColor as IconComp },
  akashchat: { Icon: AkashChatColor as IconComp },
  antgroup: { Icon: AntGroupColor as IconComp },
  anthropic: { Icon: AnthropicMono as IconComp },
  azure: { Icon: AzureColor as IconComp },
  azureai: { Icon: AzureAIColor as IconComp },
  baichuan: { Icon: BaichuanColor as IconComp },
  bailiancodingplan: { Icon: BailianColor as IconComp },
  bedrock: { Icon: BedrockColor as IconComp },
  bfl: { Icon: BflMono as IconComp },
  cerebras: { Icon: CerebrasColor as IconComp },
  chatgpt: { Icon: OpenAIMono as IconComp },
  cloudflare: { Icon: CloudflareColor as IconComp },
  cohere: { Icon: CohereColor as IconComp },
  cometapi: { Icon: CometAPIColor as IconComp },
  comfyui: { Icon: ComfyUIColor as IconComp },
  deepseek: { Icon: DeepSeekColor as IconComp },
  fal: { Icon: FalColor as IconComp },
  fireworksai: { Icon: FireworksColor as IconComp },
  giteeai: { Icon: GiteeAIMono as IconComp },
  github: { Icon: GithubMono as IconComp },
  githubcopilot: { Icon: GithubCopilotMono as IconComp },
  glmcodingplan: { Icon: ChatGLMColor as IconComp },
  google: { Icon: GoogleColor as IconComp },
  groq: { Icon: GroqMono as IconComp, color: "#F55036" },
  higress: { Icon: HigressColor as IconComp },
  huggingface: { Icon: HuggingFaceColor as IconComp },
  hunyuan: { Icon: HunyuanColor as IconComp },
  infiniai: { Icon: InfinigenceColor as IconComp },
  internlm: { Icon: InternLMColor as IconComp },
  jina: { Icon: JinaMono as IconComp },
  kimicodingplan: { Icon: KimiColor as IconComp },
  lmstudio: { Icon: LmStudioMono as IconComp },
  longcat: { Icon: LongCatColor as IconComp },
  minimax: { Icon: MinimaxColor as IconComp },
  minimaxcodingplan: { Icon: MinimaxColor as IconComp },
  mistral: { Icon: MistralColor as IconComp },
  modelscope: { Icon: ModelScopeColor as IconComp },
  moonshot: { Icon: MoonshotMono as IconComp },
  nebius: { Icon: NebiusMono as IconComp },
  newapi: { Icon: NewAPIColor as IconComp },
  novita: { Icon: NovitaColor as IconComp },
  nvidia: { Icon: NvidiaColor as IconComp },
  ollama: { Icon: OllamaMono as IconComp },
  ollamacloud: { Icon: OllamaMono as IconComp },
  openai: { Icon: OpenAIMono as IconComp },
  opencodecodingplan: { Icon: OpenCodeMono as IconComp },
  opencodezen: { Icon: OpenCodeMono as IconComp },
  openrouter: { Icon: OpenRouterColor as IconComp },
  perplexity: { Icon: PerplexityColor as IconComp },
  ppio: { Icon: PPIOColor as IconComp },
  qiniu: { Icon: QiniuColor as IconComp },
  qwen: { Icon: QwenColor as IconComp },
  replicate: { Icon: ReplicateMono as IconComp },
  sambanova: { Icon: SambaNovaColor as IconComp },
  search1api: { Icon: Search1APIColor as IconComp },
  sensenova: { Icon: SenseNovaColor as IconComp },
  siliconcloud: { Icon: SiliconCloudColor as IconComp },
  spark: { Icon: SparkColor as IconComp },
  stepfun: { Icon: StepfunMono as IconComp },
  straico: { Icon: StraicoColor as IconComp },
  streamlake: { Icon: StreamLakeColor as IconComp },
  supergrok: { Icon: GrokMono as IconComp },
  tencentcloud: { Icon: TencentCloudColor as IconComp },
  togetherai: { Icon: TogetherColor as IconComp },
  upstage: { Icon: UpstageColor as IconComp },
  v0: { Icon: V0Mono as IconComp },
  vercelaigateway: { Icon: VercelMono as IconComp },
  vertexai: { Icon: VertexAIColor as IconComp },
  vllm: { Icon: VllmColor as IconComp },
  volcengine: { Icon: VolcengineColor as IconComp },
  volcenginecodingplan: { Icon: VolcengineColor as IconComp },
  wenxin: { Icon: WenxinColor as IconComp },
  xai: { Icon: XAIMono as IconComp },
  xiaomimimo: { Icon: XiaomiMiMoMono as IconComp },
  xinference: { Icon: XinferenceColor as IconComp },
  zenmux: { Icon: ZenMuxMono as IconComp },
  zeroone: { Icon: ZeroOneColor as IconComp },
  zhipu: { Icon: ZhipuColor as IconComp },

};

/** 预设平台图标 — 按预设 id 渲染品牌图标，未知 id 返回 null */
export const PresetIcon = memo(function PresetIcon({
  presetId,
  size = 32,
}: {
  presetId: string;
  size?: number;
}) {
  const entry = PRESET_ICON_MAP[presetId];
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

export { PRESET_ICON_MAP };
