import { NextRequest } from "next/server";
import { proxyV1Request } from "@/lib/v1-proxy";

/**
 * POST /api/v1/responses — OpenAI Responses API 代理端点
 *
 * 兼容 OpenAI 新一代 Agent 化接口，支持流式和非流式响应。
 * 支持 tool calling、文件读取、网络检索等高级功能。
 */

export async function POST(request: NextRequest) {
  return proxyV1Request(request, {
    upstreamPath: "/responses",
    supportsStreaming: true,
    allowedModelTypes: ["chat"],
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
