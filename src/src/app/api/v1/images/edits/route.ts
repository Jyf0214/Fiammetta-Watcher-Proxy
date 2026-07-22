import { NextRequest } from "next/server";
import { proxyV1Request } from "@/lib/v1-proxy";

/**
 * POST /api/v1/images/edits — 图像编辑代理端点
 *
 * 兼容 OpenAI Image Edits API，支持 multipart/form-data 二进制流转发。
 * 请求体包含 image（原图）、mask（可选遮罩）、prompt 等参数。
 */

export async function POST(request: NextRequest) {
  return proxyV1Request(request, {
    upstreamPath: "/images/edits",
    supportsStreaming: false,
    streamBody: true, // multipart/form-data，直接转发原始流
  });
}
