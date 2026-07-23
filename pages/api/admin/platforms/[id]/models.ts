/**
 * 平台模型管理 API
 *
 * GET    /api/admin/platforms/:id/models  — 获取平台的模型列表
 * POST   /api/admin/platforms/:id/models  — 手动添加模型
 * PUT    /api/admin/platforms/:id/models  — 从远端平台刷新模型列表
 * DELETE /api/admin/platforms/:id/models?modelId=xxx — 删除模型
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "../../_auth";


/** 生成唯一 ID（cuid 风格） */
function generateId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * GET /api/admin/platforms/:id/models — 获取平台的模型列表
 */
async function handleGet(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const db = await createDb();
    const models = await db.platformModels.findMany({
      where: { platformId: id },
      orderBy: { modelId: "asc" },
    });

    return res.status(200).json({ success: true, data: models });
  } catch (err) {
    console.error(
      "[GET /api/admin/platforms/[id]/models] 获取平台模型失败:",
      err
    );
    return res.status(500).json({ success: false, error: "获取平台模型失败", detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * POST /api/admin/platforms/:id/models — 手动添加模型
 *
 * body: { modelId: string, modelName?: string, enabled?: boolean }
 *
 * modelId  为模型在上游平台的唯一标识（如 gpt-4o）
 * modelName 为模型的显示名称，不传则默认与 modelId 相同
 */
async function handlePost(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const body: { modelId?: string; modelName?: string } = req.body;
    const { modelId, modelName } = body;

    if (
      !modelId ||
      typeof modelId !== "string" ||
      modelId.trim().length === 0
    ) {
      return res.status(400).json({ success: false, error: "模型 ID 不能为空" });
    }

    const db = await createDb();

    // 检查平台是否存在
    const platform = await db.platforms.findFirst({ where: { id } });

    if (!platform) {
      return res.status(404).json({ success: false, error: "平台不存在" });
    }

    // 检查是否已存在相同 modelId
    const existing = await db.platformModels.findFirst({
      where: { platformId: id, modelId: modelId.trim() },
    });

    if (existing) {
      return res.status(400).json({ success: false, error: "该模型已存在" });
    }

    const now = Math.floor(Date.now() / 1000);
    const newModelId = generateId();

    const newModel = await db.platformModels.create({
      data: {
        id: newModelId,
        platformId: id,
        modelId: modelId.trim(),
        modelName: modelName?.trim() || modelId.trim(),
        type: "chat",
        source: "manual",
        fetchedAt: now,
      },
    });

    return res.status(200).json({
      success: true,
      data: newModel,
      message: "模型添加成功",
    });
  } catch (err) {
    console.error(
      "[POST /api/admin/platforms/[id]/models] 添加模型失败:",
      err
    );
    return res.status(500).json({ success: false, error: "添加模型失败", detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * DELETE /api/admin/platforms/:id/models?modelId=xxx — 删除模型
 */
async function handleDelete(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const modelId = req.query.modelId as string | undefined;

    if (!modelId) {
      return res.status(400).json({ success: false, error: "缺少 modelId 参数" });
    }

    const db = await createDb();

    // 删除匹配的记录
    await db.platformModels.deleteMany({
      where: { platformId: id, modelId: modelId },
    });

    return res.status(200).json({ success: true, message: "模型已删除" });
  } catch (err) {
    console.error(
      "[DELETE /api/admin/platforms/[id]/models] 删除模型失败:",
      err
    );
    return res.status(500).json({ success: false, error: "删除模型失败", detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * 根据模型 ID 推断类型（chat / embedding / image / audio / video / moderation）
 *
 * 匹配优先级：embedding > image > audio > video > moderation > chat
 * 嵌套关键词场景（如 video-embedding）会按优先级被更具体的类型捕获。
 */
function detectModelType(modelId: string): string {
  const id = modelId.toLowerCase();
  if (/embed|embedding|vector|text-embedding/.test(id)) return "embedding";
  if (/dall-e|stable-diffusion|midjourney|flux|image/.test(id)) return "image";
  if (/whisper|tts|speech|audio|voice/.test(id)) return "audio";
  if (/video|sora|runway|kling|pika|luma/.test(id)) return "video";
  if (/moderation|safety|content-moderation|content-safety|content-filter/.test(id)) return "moderation";
  return "chat";
}

/** OpenAI 兼容的 /v1/models 响应格式 */
interface OpenAIModel {
  id: string;
  object?: string;
  owned_by?: string;
  created?: number;
}

/**
 * PUT /api/admin/platforms/:id/models — 从远端平台刷新模型列表
 *
 * 调用上游平台的 /v1/models 接口，自动同步模型到本地数据库。
 * 新增的模型会被插入，已存在的模型会更新 fetchedAt，
 * 上游已删除的模型会从本地移除（手动添加的不会被删除）。
 */
async function handlePut(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const db = await createDb();

    // 获取平台信息
    const platform = await db.platforms.findFirst({ where: { id } });

    if (!platform) {
      return res.status(404).json({ success: false, error: "平台不存在" });
    }
    if (!platform.enabled) {
      return res.status(400).json({ success: false, error: "平台已禁用，无法刷新模型" });
    }

    // 获取 API Key（优先使用 apiKey 字段）
    const apiKey = platform.apiKey;
    if (!apiKey) {
      return res.status(400).json({ success: false, error: "平台未配置 API Key，无法刷新" });
    }

    // 调用上游模型列表接口
    const modelsUrl = `${platform.baseUrl.replace(/\/+$/, "")}/models`;
    let upstreamModels: OpenAIModel[] = [];

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(modelsUrl, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return res.status(502).json({
          success: false,
          error: `上游平台返回错误 (${response.status})`,
          detail: errorText.slice(0, 500),
        });
      }

      const data = await response.json() as { data?: OpenAIModel[] };
      upstreamModels = Array.isArray(data.data) ? data.data : [];
    } catch (fetchErr) {
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (message.includes("abort")) {
        return res.status(504).json({ success: false, error: "上游平台响应超时（15秒）" });
      }
      return res.status(502).json({ success: false, error: "无法连接到上游平台", detail: message });
    }

    if (upstreamModels.length === 0) {
      return res.status(200).json({
        success: true,
        data: { added: 0, updated: 0, removed: 0, total: 0 },
        message: "上游平台未返回任何模型",
      });
    }

    // 获取当前本地已有的模型
    const existingModels = await db.platformModels.findMany({
      where: { platformId: id },
    });

    const existingMap = new Map(existingModels.map((m) => [m.modelId, m]));
    const upstreamIds = new Set(upstreamModels.map((m) => m.id));

    const now = Math.floor(Date.now() / 1000);
    let added = 0;
    let updated = 0;
    let removed = 0;

    // 1. 新增上游有但本地没有的模型
    for (const upstream of upstreamModels) {
      if (!existingMap.has(upstream.id)) {
        await db.platformModels.create({
          data: {
            id: generateId(),
            platformId: id,
            modelId: upstream.id,
            ownedBy: upstream.owned_by || null,
            modelName: upstream.id,
            type: detectModelType(upstream.id),
            source: "auto",
            fetchedAt: now,
          },
        });
        added++;
      }
    }

    // 2. 更新已存在的模型的 fetchedAt（标记为仍然存在）
    for (const upstream of upstreamModels) {
      const existing = existingMap.get(upstream.id);
      if (existing) {
        await db.platformModels.update({
          where: { id: existing.id },
          data: { fetchedAt: now, ownedBy: upstream.owned_by || existing.ownedBy },
        });
        updated++;
      }
    }

    // 3. 删除上游已不存在且来源为 auto 的模型（保留手动添加的）
    for (const existing of existingModels) {
      if (!upstreamIds.has(existing.modelId) && existing.source === "auto") {
        await db.platformModels.delete({ where: { id: existing.id } });
        removed++;
      }
    }

    return res.status(200).json({
      success: true,
      data: { added, updated, removed, total: upstreamModels.length },
      message: `刷新完成：新增 ${added}，更新 ${updated}，移除 ${removed}`,
    });
  } catch (err) {
    console.error(
      "[PUT /api/admin/platforms/[id]/models] 刷新模型失败:",
      err
    );
    return res.status(500).json({ success: false, error: "刷新模型失败", detail: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * 路由分发
 */
/**
 * PATCH /api/admin/platforms/:id/models — 切换单个模型启禁用
 *
 * body: { modelId: string, enabled: boolean }
 */
async function handlePatch(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const body: { modelId?: string; enabled?: boolean } = req.body;
    console.log("[PATCH models] body:", JSON.stringify(body), "platformId:", id);
    if (!body?.modelId || typeof body.enabled !== "boolean") {
      console.error("[PATCH models] 参数校验失败:", body);
      return res.status(400).json({ success: false, error: "参数错误：需要 modelId 和 enabled" });
    }

    const db = await createDb();
    console.log("[PATCH models] db created, executing update...");
    const result = await db.platformModels.updateMany({
      where: { platformId: id, modelId: body.modelId },
      data: { enabled: body.enabled },
    });
    console.log("[PATCH models] update result:", JSON.stringify(result));

    return res.status(200).json({
      success: true,
      message: body.enabled ? "模型已启用" : "模型已禁用",
    });
  } catch (err) {
    console.error("[PATCH /api/admin/platforms/[id]/models] 切换模型状态失败:", err);
    console.error("[PATCH models] error stack:", err instanceof Error ? err.stack : "no stack");
    return res.status(500).json({ success: false, error: "操作失败", detail: err instanceof Error ? err.message : String(err) });
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || "");

  switch (req.method) {
    case "GET":
      return handleGet(req, res, id);
    case "POST":
      return handlePost(req, res, id);
    case "PUT":
      return handlePut(req, res, id);
    case "PATCH":
      return handlePatch(req, res, id);
    case "DELETE":
      return handleDelete(req, res, id);
    default:
      res.setHeader("Allow", ["GET", "POST", "PUT", "PATCH", "DELETE"]);
      return res.status(405).json({ success: false, error: "方法不允许" });
  }
}
