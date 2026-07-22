import { NextRequest } from "next/server";
import { proxyV1Request } from "@/lib/v1-proxy";

/**
 * POST /api/v1/audio/speech — 文字转语音（TTS）代理端点
 *
 * 兼容 OpenAI TTS API，支持流式二进制音频响应。
 * 请求体为 JSON（含 model、input、voice 等参数）。
 * 上游响应为二进制音频流（audio/mpeg 等）。
 */

export async function POST(request: NextRequest) {
  return proxyV1Request(request, {
    upstreamPath: "/audio/speech",
    supportsStreaming: false, // TTS 不使用 SSE，但响应是二进制流
    allowedModelTypes: ["audio"],
    validateBody: (body) => {
      if (!body.model) {
        return Response.json(
          { error: { message: "缺少必要的 model 参数", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
      if (!body.input) {
        return Response.json(
          { error: { message: "缺少必要的 input 参数", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
      return null;
    },
  });
}
