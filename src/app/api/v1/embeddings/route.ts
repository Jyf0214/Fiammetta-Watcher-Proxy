import { NextRequest } from "next/server";
import { proxyV1Request } from "@/lib/v1-proxy";

/**
 * POST /api/v1/embeddings — 文本向量化代理端点
 *
 * 兼容 OpenAI Embeddings API，支持所有主流嵌入模型。
 * 无流式响应，返回固定的 JSON 结构。
 */

export async function POST(request: NextRequest) {
  return proxyV1Request(request, {
    upstreamPath: "/embeddings",
    supportsStreaming: false,
    allowedModelTypes: ["embedding"],
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
