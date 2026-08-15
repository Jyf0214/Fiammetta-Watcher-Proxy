/**
 * 平台管理 CRUD API — 单个平台操作
 *
 * GET    /api/admin/platforms/:id  — 获取单个平台详情
 * PUT    /api/admin/platforms/:id  — 更新平台（支持部分字段更新）
 * DELETE /api/admin/platforms/:id  — 删除平台（需先清理关联数据）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { isSafeUrl, checkCsrfOrigin, escapeHtml } from "@/lib/admin-security";

/** 安全解析 JSON 字段，默认值为指定的 fallback */
function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 生成唯一 ID（cuid 风格） */
function newId(prefix = "c"): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * GET /api/admin/platforms/:id — 获取单个平台详情（包含 apiKeys 用于编辑回填）
 */
async function handleGet(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  try {
    const db = await createDb();
    const platform = await db.platforms.findFirst({ where: { id } });

    if (!platform) {
      return res.status(404).json({ success: false, error: "平台不存在" });
    }

    // 解析 JSON 字段为结构化数据，方便前端编辑
    const apiKeys = safeJsonParse<string[]>(platform.apiKeys, []);
    const forwardHeaders = safeJsonParse<string[]>(
      platform.forwardHeaders,
      []
    );

    return res.status(200).json({
      success: true,
      data: {
        ...platform,
        apiKeys,
        forwardHeaders,
        injectStreamOptions: platform.injectStreamOptions ?? true,
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/platforms/[id]] 获取平台失败:", err);
    return res.status(500).json({ success: false, error: "获取平台失败" });
  }
}

/**
 * PUT /api/admin/platforms/:id — 更新平台
 */
async function handlePut(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }
  if (!checkCsrfOrigin(req, res)) return;

  try {
    const body: any = req.body;

    // 字段类型校验
    const errors: string[] = [];

    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      errors.push("enabled 必须为布尔值");
    }

    if (body.weight !== undefined) {
      if (
        typeof body.weight !== "number" ||
        !Number.isInteger(body.weight) ||
        body.weight <= 0
      ) {
        errors.push("权重必须为正整数");
      }
    }

    if (body.priority !== undefined) {
      if (
        typeof body.priority !== "number" ||
        !Number.isInteger(body.priority) ||
        body.priority < 0
      ) {
        errors.push("优先级必须为非负整数");
      }
    }

    // SSRF 防护（含 DNS Rebinding 检测）
    if (body.baseUrl !== undefined) {
      if (
        typeof body.baseUrl !== "string" ||
        body.baseUrl.trim().length === 0
      ) {
        errors.push("基础 URL 不能为空");
      } else {
        const urlCheck = await isSafeUrl(body.baseUrl);
        if (!urlCheck.safe) {
          errors.push(urlCheck.reason || "URL 不安全");
        }
      }
    }

    const VALID_PLATFORM_TYPES = ["openai", "azure", "custom"] as const;
    if (
      body.type !== undefined &&
      !VALID_PLATFORM_TYPES.includes(body.type)
    ) {
      errors.push(
        `平台类型无效，允许的值为: ${VALID_PLATFORM_TYPES.join(", ")}`
      );
    }

    if (
      body.name !== undefined &&
      typeof body.name === "string" &&
      body.name.length > 100
    ) {
      errors.push("平台名称不能超过 100 个字符");
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join("; ") });
    }

    const db = await createDb();

    // 获取现有平台数据，用于编辑时保留未修改的字段
    const existing = await db.platforms.findFirst({ where: { id } });

    if (!existing) {
      return res.status(404).json({ success: false, error: "平台不存在" });
    }

    // 构建更新数据（仅包含传入的字段）
    const updateData: Record<string, unknown> = {};
    if (body.name !== undefined) updateData.name = escapeHtml(body.name);
    if (body.baseUrl !== undefined) updateData.baseUrl = body.baseUrl;
    if (body.type !== undefined) updateData.type = body.type;
    if (body.enabled !== undefined) updateData.enabled = !!body.enabled;
    if (body.priority !== undefined) updateData.priority = body.priority;
    if (body.weight !== undefined) updateData.weight = body.weight;
    if (body.rpmLimit !== undefined)
      updateData.rpmLimit = body.rpmLimit ?? null;
    if (body.tpmLimit !== undefined)
      updateData.tpmLimit = body.tpmLimit ?? null;
    if (body.injectStreamOptions !== undefined)
      updateData.injectStreamOptions = !!body.injectStreamOptions;
    if (body.whitelisted !== undefined)
      updateData.whitelisted = !!body.whitelisted;

    // 健康状态字段（用于手动恢复平台状态）— 类型和范围校验
    const VALID_STATUSES = ["healthy", "degraded", "down"];
    if (body.status !== undefined) {
      if (!VALID_STATUSES.includes(body.status)) {
        errors.push(`status 无效，允许: ${VALID_STATUSES.join(", ")}`);
      } else {
        updateData.status = body.status;
      }
    }
    if (body.failCount !== undefined) {
      if (typeof body.failCount !== "number" || !Number.isInteger(body.failCount) || body.failCount < 0) {
        errors.push("failCount 必须为非负整数");
      } else {
        updateData.failCount = body.failCount;
      }
    }
    if (body.cooldownEnd !== undefined) {
      if (body.cooldownEnd !== null && (typeof body.cooldownEnd !== "number" || body.cooldownEnd < 0)) {
        errors.push("cooldownEnd 必须为非负整数或 null");
      } else {
        updateData.cooldownEnd = body.cooldownEnd;
      }
    }
    if (body.lastFailAt !== undefined) {
      if (body.lastFailAt !== null && (typeof body.lastFailAt !== "number" || body.lastFailAt < 0)) {
        errors.push("lastFailAt 必须为非负整数或 null");
      } else {
        updateData.lastFailAt = body.lastFailAt;
      }
    }

    // 校验健康状态字段后再检查一次
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join("; ") });
    }

    // forwardHeaders 校验并更新
    if (body.forwardHeaders !== undefined) {
      if (body.forwardHeaders === "" || body.forwardHeaders === null) {
        updateData.forwardHeaders = "[]";
      } else if (typeof body.forwardHeaders === "string") {
        try {
          const parsed = JSON.parse(body.forwardHeaders);
          if (Array.isArray(parsed)) {
            const validHeaders = parsed
              .filter(
                (h: unknown): h is string =>
                  typeof h === "string" && h.trim().length > 0
              )
              .map((h: string) => h.trim());
            updateData.forwardHeaders = JSON.stringify(validHeaders);
          }
        } catch {
          // JSON 解析失败，保留原值
        }
      }
    }

    // apiKeys 在编辑时可选（不提供则保留原值）
    // 支持两种格式：字符串数组 ["key1", "key2"] 或对象数组 [{name, key, whitelisted}]
    if (body.apiKeys !== undefined && body.apiKeys !== null) {
      // 兼容直接传数组的客户端：统一转 JSON 字符串后解析
      const rawApiKeys =
        typeof body.apiKeys === "string" ? body.apiKeys : JSON.stringify(body.apiKeys);
      if (rawApiKeys === "") {
        updateData.apiKeys = "[]";
      } else {
        try {
          const parsed = JSON.parse(rawApiKeys);
          if (Array.isArray(parsed)) {
            // 检查是否为对象数组格式 [{name, key}]
            if (
              parsed.length > 0 &&
              typeof parsed[0] === "object" &&
              parsed[0] !== null &&
              "key" in parsed[0]
            ) {
              // 命名密钥格式
              const validKeys = parsed
                .filter(
                  (k: unknown): k is Record<string, unknown> =>
                    typeof k === "object" &&
                    k !== null &&
                    typeof (k as Record<string, unknown>).key === "string" &&
                    ((k as Record<string, unknown>).key as string).trim().length > 0 &&
                    ((k as Record<string, unknown>).key as string).length <= 500
                )
                .map((k) => {
                  const obj: Record<string, unknown> = {
                    name: typeof k.name === "string" && k.name.trim() ? k.name.trim() : "Key",
                    key: (k.key as string).trim(),
                  };
                  if (k.whitelisted === true) obj.whitelisted = true;
                  if (k.enabled === false) obj.enabled = false;
                  if (typeof k.errorCount === "number" && k.errorCount > 0) obj.errorCount = k.errorCount;
                  return obj;
                });
              updateData.apiKeys = JSON.stringify(validKeys);
            } else {
              // 旧格式：字符串数组
              const validKeys = parsed.filter(
                (k: unknown): k is string =>
                  typeof k === "string" &&
                  k.trim().length > 0 &&
                  k.length <= 500
              );
              updateData.apiKeys = JSON.stringify(validKeys);
            }
          }
        } catch {
          // JSON 解析失败，保留原值
        }
      }
    }

    // 无任何更新字段时直接返回
    if (Object.keys(updateData).length === 0) {
      return res.status(200).json({
        success: true,
        data: existing,
        message: "未检测到变更",
      });
    }

    // 更新时间戳
    updateData.updatedAt = Math.floor(Date.now() / 1000);

    await db.platforms.update({ where: { id }, data: updateData });

    // 审计日志（脱敏处理：密钥只记录数量，绝不记录任何内容）
    const sanitized = { ...body };
    // 旧客户端可能仍提交 apiKey 字段：丢弃，防止明文写入审计日志
    delete sanitized.apiKey;
    if (sanitized.apiKeys !== undefined && sanitized.apiKeys !== null) {
      let keyCount = 0;
      try {
        const arr =
          typeof sanitized.apiKeys === "string"
            ? JSON.parse(sanitized.apiKeys)
            : sanitized.apiKeys;
        if (Array.isArray(arr)) keyCount = arr.length;
      } catch {
        keyCount = 0;
      }
      sanitized.apiKeys = `${keyCount} 个密钥（内容脱敏）`;
    }

    const now = Math.floor(Date.now() / 1000);
    await db.auditLogs.create({
      data: {
        id: newId(),
        adminId: getAuditAdminId(admin),
        action: "update_platform",
        detail: JSON.stringify({ platformId: id, changes: sanitized }),
        ip:
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
        createdAt: now,
      },
    });

    // 返回更新后的数据
    const updatedPlatform = await db.platforms.findFirst({ where: { id } });

    return res.status(200).json({
      success: true,
      data: updatedPlatform,
      message: "平台更新成功",
    });
  } catch (err) {
    console.error("[PUT /api/admin/platforms/[id]] 更新平台失败:", err);
    return res.status(500).json({ success: false, error: "更新平台失败" });
  }
}

/**
 * DELETE /api/admin/platforms/:id — 删除平台
 *
 * 删除前校验：
 * - 检查是否被模型映射（model_mappings）引用，被引用时拒绝删除
 * - 清理关联的请求日志和平台模型
 */
async function handleDelete(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }
  if (!checkCsrfOrigin(req, res)) return;

  try {
    const db = await createDb();

    // 检查是否存在关联的 model_mappings 记录
    const relatedMappings = await db.modelMappings.findMany({
      where: { platformId: id },
    });

    if (relatedMappings.length > 0) {
      return res.status(400).json({
        success: false,
        error: `该平台被 ${relatedMappings.length} 个模型映射引用，无法删除。请先删除相关映射。`,
      });
    }

    // 统计并清理关联数据
    // 删除关联的请求日志
    await db.requestLogs.deleteMany({ where: { platformId: id } });

    // 删除关联的平台模型
    await db.platformModels.deleteMany({ where: { platformId: id } });

    // 删除平台本身
    await db.platforms.delete({ where: { id } });

    // 审计日志
    const now = Math.floor(Date.now() / 1000);
    await db.auditLogs.create({
      data: {
        id: newId(),
        adminId: getAuditAdminId(admin),
        action: "delete_platform",
        detail: JSON.stringify({ platformId: id }),
        ip:
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
        createdAt: now,
      },
    });

    return res.status(200).json({
      success: true,
      message: "平台删除成功",
    });
  } catch (err) {
    console.error("[DELETE /api/admin/platforms/[id]] 删除平台失败:", err);
    return res.status(500).json({
      success: false,
      error: "删除平台失败",
    });
  }
}

/**
 * 路由分发
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id || "");

  switch (req.method) {
    case "GET":
      return handleGet(req, res, id);
    case "PUT":
      return handlePut(req, res, id);
    case "DELETE":
      return handleDelete(req, res, id);
    default:
      res.setHeader("Allow", ["GET", "PUT", "DELETE"]);
      return res.status(405).json({ success: false, error: "方法不允许" });
  }
}
