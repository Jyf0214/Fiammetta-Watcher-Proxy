import { NextRequest } from "next/server";
import { proxyV1Request } from "@/lib/v1-proxy";

/**
 * POST /api/v1/audio/transcriptions — 语音转文字代理端点
 *
 * 兼容 OpenAI Whisper API，支持 multipart/form-data 二进制流转发。
 * 请求体为 multipart 格式，包含 file（音频文件）和其他参数。
 * 上游响应为 JSON（转写结果）或二进制流。
 */

export async function POST(request: NextRequest) {
  return proxyV1Request(request, {
    upstreamPath: "/audio/transcriptions",
    supportsStreaming: false,
    streamBody: true, // multipart/form-data，直接转发原始流
  });
}
