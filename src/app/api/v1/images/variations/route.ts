import { NextRequest } from "next/server";
import { proxyV1Request } from "@/lib/v1-proxy";

/**
 * POST /api/v1/images/variations — 图像变体代理端点
 *
 * 兼容 OpenAI Image Variations API，支持 multipart/form-data 二进制流转发。
 * 请求体包含 image（原图）和其他参数。
 */

export async function POST(request: NextRequest) {
  return proxyV1Request(request, {
    upstreamPath: "/images/variations",
    supportsStreaming: false,
    streamBody: true, // multipart/form-data，直接转发原始流
  });
}
