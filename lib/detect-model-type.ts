/**
 * 根据模型 ID 推断类型（chat / embedding / image / audio / video / moderation）
 *
 * 匹配优先级：embedding > image > audio > video > moderation > chat
 * 嵌套关键词场景（如 video-embedding）会按优先级被更具体的类型捕获。
 *
 * 全项目唯一实现：worker/src/model-fetcher.ts（cron 抓取）与
 * pages/api/admin/platforms/[id]/models.ts（后台刷新）共同引用，
 * 避免多份实现漂移导致同一模型在不同入口入库后 type 不一致。
 */
export function detectModelType(modelId: string): string {
  const id = modelId.toLowerCase();

  if (/embed|embedding|vector|bge-|e5-|gte-|text-embedding/.test(id)) return "embedding";

  if (
    /dall-e|stable-diffusion|midjourney|flux|sdxl|cogview|gpt-image|diffusion|imagen|firefly|image|^sd-/.test(id)
  ) return "image";

  if (/whisper|tts|speech|audio|voice|cosyvoice|bark/.test(id)) return "audio";

  if (/video|sora|runway|kling|pika|luma|veo|wan[-_]?\d|hailuo|pixeldance|vidu|mochi/.test(id)) return "video";

  if (/moderation|safety|content-moderation|content-safety|content-filter/.test(id)) return "moderation";

  return "chat";
}
