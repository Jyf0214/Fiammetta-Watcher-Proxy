import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/v1/models/{model} — 查询特定模型信息
 *
 * 返回 OpenAI 兼容格式的模型元数据。
 * 模型信息来源于 platform_models 表（自动发现 + 手动添加）。
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ model: string }> }
) {
  const { model: modelId } = await params;

  // 解码 URL 编码的模型名（如 gpt-4o → gpt-4o，meta/llama → meta%2Fllama）
  const decodedModelId = decodeURIComponent(modelId);

  // 1. 验证 API Key
  const authHeader = _request.headers.get("authorization");
  const apiKeyStr = authHeader?.replace("Bearer ", "");

  if (!apiKeyStr) {
    return Response.json(
      { error: { message: "缺少 API Key", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  const apiKey = await prisma.apiKey.findUnique({
    where: { key: apiKeyStr },
  });

  if (!apiKey || apiKey.status !== "active") {
    return Response.json(
      { error: { message: "无效的 API Key", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return Response.json(
      { error: { message: "API Key 已过期", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  // 2. 查询平台模型记录
  const platformModel = await prisma.platformModel.findFirst({
    where: { modelId: decodedModelId },
    include: {
      platform: {
        select: { id: true, name: true, enabled: true },
      },
    },
  });

  if (!platformModel) {
    return Response.json(
      {
        error: {
          message: `模型 '${decodedModelId}' 不存在`,
          type: "invalid_request_error",
        },
      },
      { status: 404 }
    );
  }

  // 3. 返回 OpenAI 兼容格式
  return Response.json({
    id: platformModel.modelId,
    object: "model",
    created: Math.floor(platformModel.fetchedAt.getTime() / 1000),
    owned_by: platformModel.ownedBy || platformModel.platform.name,
    permission: [],
    root: platformModel.modelId,
    parent: null,
  });
}
