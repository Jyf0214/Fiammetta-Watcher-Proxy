import { NextRequest } from "next/server";
import { proxyV1Request } from "@/lib/v1-proxy";

/**
 * POST /api/v1/audio/translations — 语音翻译代理端点
 *
 * 兼容 OpenAI Audio Translations API，支持 multipart/form-data 二进制流转发。
 * 将源语言音频翻译并转写为英文。
 */

export async function POST(request: NextRequest) {
  return proxyV1Request(request, {
    upstreamPath: "/audio/translations",
    supportsStreaming: false,
    streamBody: true, // multipart/form-data，直接转发原始流
  });
}
