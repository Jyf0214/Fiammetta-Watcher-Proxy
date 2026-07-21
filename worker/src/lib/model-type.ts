/**
 * 模型类型自动判别
 *
 * 根据模型 ID 名称特征自动分类，支持以下类型：
 * - chat: 文字生成/对话模型（默认）
 * - image: 图片生成模型
 * - audio: 音频处理模型
 * - embedding: 向量化模型
 *
 * 90% 以上的大模型都有明显的名称规律，通过正则匹配即可准确分类。
 * 分类结果存入 PlatformModel.type 字段，供运行时路由校验使用。
 */

export type ModelType = "chat" | "image" | "audio" | "embedding";

/**
 * 根据模型 ID 自动判别模型类型
 *
 * 匹配顺序：图片 > 向量 > 音频 > 默认(chat)
 * 优先匹配图片模型，防止 gpt-image 等被误判为 chat。
 */
export function detectModelType(modelId: string): ModelType {
  const id = modelId.toLowerCase();

  // 1. 图片生成模型
  if (
    id.includes("dall-e") ||
    id.includes("dalle") ||
    id.includes("flux") ||
    id.includes("stable-diffusion") ||
    id.includes("sdxl") ||
    id.includes("cogview") ||
    id.includes("midjourney") ||
    id.includes("playground") ||
    id.includes("gpt-image") ||
    id.includes("ideogram") ||
    id.includes("kandinsky") ||
    id.includes("firefly") ||
    id.includes("image") ||
    id.startsWith("sd-")
  ) {
    return "image";
  }

  // 2. 向量化模型
  if (
    id.includes("embedding") ||
    id.includes("bge-") ||
    id.includes("e5-") ||
    id.includes("gte-") ||
    id.includes("instructor-") ||
    id.startsWith("text-similarity") ||
    id.startsWith("text-embedding")
  ) {
    return "embedding";
  }

  // 3. 音频模型
  if (
    id.includes("whisper") ||
    id.includes("tts-") ||
    id.includes("speech") ||
    id.includes("cosyvoice") ||
    id.includes("bark") ||
    id.includes("piper") ||
    id.includes("musicgen") ||
    id.includes("audiogen")
  ) {
    return "audio";
  }

  // 4. 默认：文字/对话模型
  return "chat";
}

/**
 * 模型类型到端点路径的映射
 */
export const MODEL_TYPE_ENDPOINTS: Record<ModelType, string> = {
  chat: "/v1/chat/completions",
  image: "/v1/images/generations",
  audio: "/v1/audio/speech",
  embedding: "/v1/embeddings",
};

/**
 * 模型类型到中文名称的映射（用于错误提示）
 */
export const MODEL_TYPE_NAMES: Record<ModelType, string> = {
  chat: "文字生成/对话",
  image: "图片生成",
  audio: "音频处理",
  embedding: "文本向量化",
};
