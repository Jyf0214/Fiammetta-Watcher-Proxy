/**
 * GET /v1/models 和 GET /v1/models/:model — 模型列表端点
 *
 * 返回 platform_models 表中的模型数据，格式兼容 OpenAI 模型列表接口。
 * 无需 API Key 认证，端点默认公开。
 */

import type { Context } from "hono";
import type { Env } from "../../types";
import { createDb } from "../../db";
import { platformModels } from "../../db/schema";
import { eq } from "drizzle-orm";

export async function models(c: Context<{ Bindings: Env }>) {
  const db = createDb(c.env.DB);
  const modelParam = c.req.param("model");

  // 单个模型查询
  if (modelParam) {
    const model = await db
      .select()
      .from(platformModels)
      .where(eq(platformModels.modelId, modelParam))
      .get();

    if (!model) {
      return c.json(
        { error: { message: `模型 '${modelParam}' 不存在`, type: "invalid_request_error" } },
        404
      );
    }

    return c.json({
      id: model.modelId,
      object: "model",
      created: Math.floor(new Date(model.fetchedAt).getTime() / 1000),
      owned_by: model.ownedBy || "unknown",
      // 附加平台信息供前端使用
      _platform_id: model.platformId,
      _type: model.type,
      _source: model.source,
    });
  }

  // 模型列表查询
  const allModels = await db
    .select()
    .from(platformModels)
    .all();

  return c.json({
    object: "list",
    data: allModels.map((model) => ({
      id: model.modelId,
      object: "model",
      created: Math.floor(new Date(model.fetchedAt).getTime() / 1000),
      owned_by: model.ownedBy || "unknown",
      // 附加平台信息供前端使用
      _platform_id: model.platformId,
      _type: model.type,
      _source: model.source,
    })),
  });
}
