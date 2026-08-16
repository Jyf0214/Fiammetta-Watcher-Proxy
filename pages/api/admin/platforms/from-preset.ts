/**
 * 预设平台一键创建 API
 *
 * POST /api/admin/platforms/from-preset — 按预设模板创建平台并批量写入预设模型
 *
 * body: { presetId, name?, baseUrl?, apiKeys? }
 *  - presetId 必填，对应 src/lib/presets 中的预设平台
 *  - baseUrl 可选，覆盖预设默认地址；预设无默认地址时必填
 *  - apiKeys 可选，为空则创建后可在详情页补充
 *  - name 可选，覆盖预设显示名
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb, getDbKind } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { isSafeUrl, checkCsrfOrigin, escapeHtml } from "@/lib/admin-security";
import { getPresetPlatform } from "@/lib/presets";
import { detectModelType } from "@/lib/detect-model-type";

/** 生成唯一 ID（cuid 风格） */
function newId(prefix = "c"): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 解析 apiKeys JSON（兼容命名对象与字符串数组；允许空数组） */
function parseApiKeys(raw: unknown): { name: string; key: string }[] | null {
  if (raw === undefined || raw === null || raw === "") return [];
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const keys: { name: string; key: string }[] = [];
    for (const k of parsed) {
      if (typeof k === "string") {
        if (k.trim().length > 0 && k.length <= 500) {
          keys.push({ name: `密钥${keys.length + 1}`, key: k.trim() });
        }
      } else if (typeof k === "object" && k !== null && typeof k.key === "string") {
        if (k.key.trim().length > 0 && k.key.length <= 500) {
          keys.push({
            name: typeof k.name === "string" && k.name.trim() ? k.name.trim() : `密钥${keys.length + 1}`,
            key: k.key.trim(),
          });
        }
      }
    }
    return keys;
  } catch {
    return null;
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ success: false, error: "方法不允许" });
  }

  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }
  if (!checkCsrfOrigin(req, res)) return;
  if (!(await checkAdminRateLimit(admin.adminId, res))) return;

  const body: any = req.body ?? {};
  const { presetId, name, baseUrl, apiKeys } = body;

  // 预设校验
  if (!presetId || typeof presetId !== "string") {
    return res.status(400).json({ success: false, error: "预设平台标识不能为空" });
  }
  const preset = getPresetPlatform(presetId);
  if (!preset) {
    return res.status(404).json({ success: false, error: `预设平台不存在: ${presetId}` });
  }

  const errors: string[] = [];

  // 名称
  let finalName = preset.name;
  if (name !== undefined && name !== null && name !== "") {
    if (typeof name !== "string" || name.trim().length === 0) {
      errors.push("平台名称不能为空");
    } else if (name.trim().length > 100) {
      errors.push("平台名称不能超过 100 个字符");
    } else {
      finalName = name.trim();
    }
  }

  // baseUrl：显式传入优先，否则用预设默认；都没有则要求填写
  const finalBaseUrl = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : (preset.baseUrl ?? "");
  if (!finalBaseUrl) {
    errors.push("该预设未提供默认 API 地址，请填写");
  } else {
    const urlCheck = await isSafeUrl(finalBaseUrl);
    if (!urlCheck.safe) {
      errors.push(urlCheck.reason || "URL 不安全");
    }
  }

  // apiKeys：可选（预设创建后可在详情页补充密钥）
  let parsedApiKeys: { name: string; key: string }[] = [];
  const parsed = parseApiKeys(apiKeys);
  if (parsed === null) {
    errors.push("API 密钥 JSON 格式错误");
  } else {
    parsedApiKeys = parsed;
  }

  if (errors.length > 0) {
    return res.status(400).json({ success: false, error: errors.join("; ") });
  }

  const now = Math.floor(Date.now() / 1000);
  const platformId = newId();

  try {
    const db = await createDb();
    const dbKind = await getDbKind();

    // 平台创建 + 预设模型批量写入 + 审计日志原子提交：
    // 非 D1 数据库用事务，避免平台创建成功但模型写入失败留下半成品平台；
    // D1 不支持事务（与 models.ts executeWithRetry 注释一致），直接顺序执行
    const modelCount = preset.models.length;
    const runCreate = async (tx: any) => {
      // 创建平台（预设模板：启用、默认优先级/权重）
      await tx.platforms.create({
        data: {
          id: platformId,
          name: escapeHtml(finalName),
          baseUrl: finalBaseUrl,
          apiKeys: JSON.stringify(parsedApiKeys),
          type: preset.type,
          presetId: preset.id,
          enabled: true,
          priority: 0,
          weight: 1,
          rpmLimit: null,
          tpmLimit: null,
          status: "healthy",
          failCount: 0,
          forwardHeaders: "[]",
          injectStreamOptions: true,
          whitelisted: false,
          extraHeaders: "{}",
          createdAt: now,
          updatedAt: now,
        },
      });

      // 批量写入预设模型（模型 ID 列表，类型由 ID 自动推导；每批 100 条）
      for (let i = 0; i < modelCount; i += 100) {
        const batch = preset.models.slice(i, i + 100);
        await tx.platformModels.createMany({
          data: batch.map((modelId) => ({
            id: newId("m"),
            platformId,
            modelId,
            modelName: modelId,
            type: detectModelType(modelId),
            source: "manual",
            enabled: true,
            fetchedAt: now,
          })),
        });
      }

      // 审计日志
      await tx.auditLogs.create({
        data: {
          id: newId(),
          adminId: getAuditAdminId(admin),
          action: "create_platform",
          detail: JSON.stringify({ platformId, name: finalName, fromPreset: presetId, modelCount }),
          ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
          createdAt: now,
        },
      });
    };

    if (dbKind === "d1") {
      await runCreate(db);
    } else {
      await db.$transaction(async (tx: any) => {
        await runCreate(tx);
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        id: platformId,
        name: finalName,
        baseUrl: finalBaseUrl,
        type: preset.type,
        presetId: preset.id,
        enabled: true,
        modelCount,
      },
      message: `平台创建成功，已导入 ${modelCount} 个预设模型`,
    });
  } catch (err) {
    console.error("[POST /api/admin/platforms/from-preset] 创建平台失败:", err);
    return res.status(500).json({ success: false, error: "创建平台失败" });
  }
}
