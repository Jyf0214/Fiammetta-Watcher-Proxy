import { NextRequest } from "next/server";
import { proxyV1Request } from "@/lib/v1-proxy";

/**
 * POST /api/v1/images/generations — 文生图代理端点
 *
 * 兼容 OpenAI DALL-E API，支持 Stable Diffusion、Flux 等模型。
 * 请求体为 JSON（含 model、prompt、size 等参数）。
 * 上游响应为 JSON（含图片 URL 或 base64 数据）。
 */

export async function POST(request: NextRequest) {
  return proxyV1Request(request, {
    upstreamPath: "/images/generations",
    supportsStreaming: false,
    allowedModelTypes: ["image"],
    validateBody: (body) => {
      if (!body.model) {
        return Response.json(
          { error: { message: "缺少必要的 model 参数", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
      if (!body.prompt) {
        return Response.json(
          { error: { message: "缺少必要的 prompt 参数", type: "invalid_request_error" } },
          { status: 400 }
        );
      }
      return null;
    },
  });
}
