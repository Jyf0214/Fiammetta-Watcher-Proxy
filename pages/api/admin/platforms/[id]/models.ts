/**
 * 平台模型管理 API
 *
 * GET    /api/admin/platforms/:id/models  — 获取平台的模型列表
 * POST   /api/admin/platforms/:id/models  — 手动添加模型
 * PUT    /api/admin/platforms/:id/models  — 从远端平台刷新模型列表
 * DELETE /api/admin/platforms/:id/models?modelId=xxx — 删除模型
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb, getDbKind } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkCsrfOrigin, isSafeUrl } from "@/lib/admin-security";
import { detectModelType } from "@/lib/detect-model-type";

/** MySQL/TiDB 锁等待超时错误码 */
const LOCK_WAIT_TIMEOUT_CODE = 1205;
/** 最大重试次数 */
const MAX_RETRIES = 3;
/** 初始重试延迟（毫秒） */
const INITIAL_RETRY_DELAY_MS = 100;

/** 生成唯一 ID（cuid 风格） */
function generateId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 判断错误是否为锁等待超时
 */
function isLockWaitTimeout(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  // Prisma 错误结构：{ code: 'P2034', meta: { code: 1205, ... } }
  if (e.code === "P2034") return true;
  // 原生 MySQL 错误
  if (typeof e.meta === "object" && e.meta !== null) {
    const meta = e.meta as Record<string, unknown>;
    if (meta.code === LOCK_WAIT_TIMEOUT_CODE) return true;
  }
  // 直接包含错误码的情况
  if (typeof e.message === "string" && e.message.includes("1205")) return true;
  if (typeof e.message === "string" && e.message.includes("Lock wait timeout")) return true;
  return false;
}

/**
 * 带重试的事务执行（仅非 D1 数据库）
 * D1 不支持事务，直接执行不重试
 */
async function executeWithRetry<T>(
  prisma: any,
  dbKind: string,
  fn: () => Promise<T>,
  operationName: string
): Promise<T> {
  // D1 不支持事务，也不重试（D1 无锁等待超时问题）
  if (dbKind === "d1") {
    return fn();
  }

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // 非 D1 数据库使用事务
      return await prisma.$transaction(async (_tx: any) => {
        // 将 tx 绑定到 fn 的上下文（通过闭包）
        return await fn();
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (isLockWaitTimeout(err) && attempt < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[PUT /api/admin/platforms/[id]/models] ${operationName} 遇到锁等待超时 (尝试 ${attempt + 1}/${MAX_RETRIES + 1})，${delay}ms 后重试: ${lastError.message}`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
}

/** 解析平台 apiKeys JSON 为密钥列表（兼容命名对象与字符串数组格式） */
function parsePlatformKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: unknown) => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).key === "string") {
          return (item as Record<string, unknown>).key as string;
        }
        return "";
      })
      .filter((k: string) => k.trim().length > 0);
  } catch {
    return [];
  }
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
    return res.status(500).json({ success: false, error: "获取平台模型失败" });
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

  if (!checkCsrfOrigin(req, res)) return;

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
    return res.status(500).json({ success: false, error: "添加模型失败" });
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

  if (!checkCsrfOrigin(req, res)) return;

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
    return res.status(500).json({ success: false, error: "删除模型失败" });
  }
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

  if (!checkCsrfOrigin(req, res)) return;

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

    // 获取 API Key（平台密钥数组中的第一个可用密钥）
    const apiKeys = parsePlatformKeys(platform.apiKeys);
    const apiKey = apiKeys[0] ?? null;
    if (!apiKey) {
      return res.status(400).json({ success: false, error: "平台未配置 API Key，无法刷新" });
    }

    // SSRF 防护：刷新模型同样校验上游地址（此前无校验，与 model-fetcher 一致
    // 会形成盲 SSRF，响应数据入库后可经未认证 GET /v1/models 外带）。
    // 用 isSafeUrl（含 DNS 解析层，防 AAAA-only 内网域名/DNS Rebinding），
    // 与平台创建/更新路径的校验强度一致
    const urlCheck = await isSafeUrl(platform.baseUrl);
    if (!urlCheck.safe) {
      return res.status(400).json({ success: false, error: `上游 URL 不安全: ${urlCheck.reason}` });
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
        // 禁止跟随重定向：校验只作用于初始 URL，跟随 3xx 可能重定向到内网
        redirect: "manual",
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return res.status(502).json({
          success: false,
          error: `上游平台返回错误 (${response.status})`,
        });
      }

      const data = await response.json() as { data?: OpenAIModel[] };
      upstreamModels = Array.isArray(data.data) ? data.data : [];
    } catch (fetchErr) {
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (message.includes("abort")) {
        return res.status(504).json({ success: false, error: "上游平台响应超时（15秒）" });
      }
      return res.status(502).json({ success: false, error: "无法连接到上游平台" });
    }

    if (upstreamModels.length === 0) {
      return res.status(200).json({
        success: true,
        data: { added: 0, updated: 0, removed: 0, total: 0 },
        message: "上游平台未返回任何模型",
      });
    }

    // 获取数据库类型用于事务重试判断
    const dbKind = await getDbKind();

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

    // 使用事务批量操作（带重试）
    await executeWithRetry(
      db,
      dbKind,
      async () => {
        // 1. 批量新增上游有但本地没有的模型
        const toCreate = upstreamModels
          .filter((upstream) => !existingMap.has(upstream.id))
          .map((upstream) => ({
            id: generateId(),
            platformId: id,
            modelId: upstream.id,
            ownedBy: upstream.owned_by || null,
            modelName: upstream.id,
            type: detectModelType(upstream.id),
            source: "auto" as const,
            fetchedAt: now,
          }));

        if (toCreate.length > 0) {
          // 分批插入（D1 限制每次最多 100 条，其他数据库也建议分批）
          for (let i = 0; i < toCreate.length; i += 100) {
            await db.platformModels.createMany({
              data: toCreate.slice(i, i + 100),
            });
          }
          added = toCreate.length;
        }

        // 2. 批量更新已存在的模型的 fetchedAt 与 type
        const toUpdate = upstreamModels
          .map((upstream) => existingMap.get(upstream.id))
          .filter((existing): existing is typeof existingModels[0] => existing !== undefined);

        if (toUpdate.length > 0) {
          // 使用 updateMany 配合多个 where 条件（Prisma 支持）
          // 但 updateMany 只能更新相同字段，这里需要根据每个模型更新不同的 ownedBy 和 type
          // 所以只能逐个 update，但在事务中批量执行
          for (const upstream of upstreamModels) {
            const existing = existingMap.get(upstream.id);
            if (existing) {
              await db.platformModels.update({
                where: { id: existing.id },
                data: {
                  fetchedAt: now,
                  ownedBy: upstream.owned_by || existing.ownedBy,
                  type: detectModelType(upstream.id),
                },
              });
              updated++;
            }
          }
        }

        // 3. 批量删除上游已不存在且来源为 auto 的模型
        const toDelete = existingModels.filter(
          (existing) => !upstreamIds.has(existing.modelId) && existing.source === "auto"
        );

        if (toDelete.length > 0) {
          await db.platformModels.deleteMany({
            where: {
              id: { in: toDelete.map((m) => m.id) },
            },
          });
          removed = toDelete.length;
        }
      },
      `平台 ${id} 模型刷新`
    );

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
    return res.status(500).json({ success: false, error: "刷新模型失败" });
  }
}

/**
 * PATCH /api/admin/platforms/:id/models — 切换模型启禁用
 *
 * body: { modelId: string, enabled: boolean }        → 切换单个模型
 * body: { enabled: boolean }                          → 批量切换所有模型
 */
async function handlePatch(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  if (!checkCsrfOrigin(req, res)) return;

  try {
    const body: { modelId?: string; enabled?: boolean } = req.body;
    if (typeof body?.enabled !== "boolean") {
      return res.status(400).json({ success: false, error: "参数错误：需要 enabled 字段" });
    }

    const db = await createDb();

    if (body.modelId) {
      // 单个模型切换
      await db.platformModels.updateMany({
        where: { platformId: id, modelId: body.modelId },
        data: { enabled: body.enabled },
      });
      return res.status(200).json({
        success: true,
        message: body.enabled ? "模型已启用" : "模型已禁用",
      });
    }

    // 批量切换该平台所有模型
    const result = await db.platformModels.updateMany({
      where: { platformId: id },
      data: { enabled: body.enabled },
    });

    return res.status(200).json({
      success: true,
      message: body.enabled
        ? `已启用 ${result.count} 个模型`
        : `已禁用 ${result.count} 个模型`,
      data: { affected: result.count },
    });
  } catch (err) {
    console.error("[PATCH /api/admin/platforms/[id]/models] 切换模型状态失败:", err);
    return res.status(500).json({ success: false, error: "操作失败" });
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
