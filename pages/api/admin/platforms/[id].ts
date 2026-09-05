/**
 * 平台管理 CRUD API — 单个平台操作
 *
 * GET    /api/admin/platforms/:id  — 获取单个平台详情
 * PUT    /api/admin/platforms/:id  — 更新平台（支持部分字段更新）
 * DELETE /api/admin/platforms/:id  — 删除平台（需先清理关联数据）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { invalidateRouterCache } from "../../../../worker/src/router";
import { invalidateApiKeyCache } from "../../../../worker/src/auth";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { isSafeUrl, checkCsrfOrigin } from "@/lib/admin-security";
import { readPlatformKeyStatus, type PlatformKeyStatus } from "@/lib/key-status";
import { getKeyStatusesFromMemory, parseApiKeys } from "../../../../worker/src/platform-keys";
import { resolvePlatformProtocols, type PlatformType } from "../../../../lib/types";
import { resetCircuitBreaker } from "../../../../worker/src/load-balancer";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { getClientIp } from "../auth";

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
  // 明文密钥下发端点必须限流：凭据泄露时可被反复拉取整库明文
  // （与 export.ts 同理由，见 export.ts checkAdminRateLimit 注释）
  if (!(await checkAdminRateLimit(admin.adminId, res))) return;

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

    // 密钥实时状态（429 封禁/白名单降级）：KV 持久化状态（Cloudflare 部署）
    // 合并同进程内存态（Docker/EdgeOne 部署：admin 与 v1 路由同 Node 进程，
    // 直接读模块级冷却 Map 即可反映实时封禁，且无 KV 时是唯一状态源）
    let keyStatuses: PlatformKeyStatus = {};
    let kv: KVNamespace | undefined;
    try {
      const { getCloudflareContext } = await import("@opennextjs/cloudflare");
      kv = getCloudflareContext().env.KV as KVNamespace | undefined;
    } catch {
      // 本地开发或非 Cloudflare 环境没有 KV binding
    }
    if (kv) {
      keyStatuses = await readPlatformKeyStatus(kv, id);
    }
    const memoryStatuses = getKeyStatusesFromMemory(id, parseApiKeys(platform.apiKeys ?? "[]"));
    keyStatuses = { ...keyStatuses, ...memoryStatuses };

    return res.status(200).json({
      success: true,
      data: {
        ...platform,
        apiKeys,
        forwardHeaders,
        injectStreamOptions: platform.injectStreamOptions ?? true,
        reuseUserAgent: platform.reuseUserAgent ?? false,
        customUserAgent: platform.customUserAgent ?? "",
        extraHeaders: platform.extraHeaders ?? "{}",
        keyStatuses,
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
  if (!(await checkAdminRateLimit(admin.adminId, res))) return;

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

    if (body.rpmLimit !== undefined && body.rpmLimit !== null) {
      if (
        typeof body.rpmLimit !== "number" ||
        !Number.isInteger(body.rpmLimit) ||
        body.rpmLimit < 0
      ) {
        errors.push("RPM 限制必须是非负整数");
      }
    }

    if (body.tpmLimit !== undefined && body.tpmLimit !== null) {
      if (
        typeof body.tpmLimit !== "number" ||
        !Number.isInteger(body.tpmLimit) ||
        body.tpmLimit < 0
      ) {
        errors.push("TPM 限制必须是非负整数");
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

    const VALID_PLATFORM_TYPES = ["openai", "azure", "custom", "anthropic", "gemini"] as const;
    if (
      body.type !== undefined &&
      !VALID_PLATFORM_TYPES.includes(body.type)
    ) {
      errors.push(
        `平台类型无效，允许的值为: ${VALID_PLATFORM_TYPES.join(", ")}`
      );
    }

    if (body.name !== undefined) {
      if (typeof body.name !== "string") {
        errors.push("平台名称必须为字符串");
      } else if (body.name.length > 100) {
        errors.push("平台名称不能超过 100 个字符");
      }
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

    // 计算最终 type（前端可能不传 type，PUT 部分更新保留旧 type）
    const finalType: PlatformType = body.type !== undefined
      ? (VALID_PLATFORM_TYPES.includes(body.type) ? body.type : existing.type as PlatformType)
      : (existing.type as PlatformType);

    // 构建更新数据（仅包含传入的字段）
    // name 只做 trim，不做 escapeHtml（React 前端渲染会自动转义，
    // 存库转义会对已转义文本二次转义 → &amp;amp; 不可逆累积损坏）
    const updateData: Record<string, unknown> = {};
    if (body.name !== undefined) updateData.name = body.name.trim();
    if (body.baseUrl !== undefined) updateData.baseUrl = body.baseUrl;
    if (body.type !== undefined) updateData.type = body.type;
    if (body.enabled !== undefined) updateData.enabled = !!body.enabled;

    // 单平台多协议：types 字段在 PUT 里也参与解析。规则同 POST（首项必须 = finalType）
    if (body.types !== undefined && body.types !== null) {
      const raw = body.types;
      const arr: unknown[] = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? (() => {
              try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) ? parsed : [];
              } catch {
                return [];
              }
            })()
          : [];
      const nextTypes: PlatformType[] = [];
      for (const item of arr) {
        if (VALID_PLATFORM_TYPES.includes(item as PlatformType)) {
          const p = item as PlatformType;
          if (!nextTypes.includes(p)) nextTypes.push(p);
        }
      }
      // 整组非法 → 沿用库中已有 types（不允许 PUT 把整组清空成「无协议」导致 422）
      if (nextTypes.length === 0) {
        const fallback = resolvePlatformProtocols(existing.types ?? null, finalType);
        updateData.types = JSON.stringify(fallback);
      } else {
        // 首选协议对齐 finalType（type 与 types[0] 一致是平台型协议枚举的不变量）
        const aligned: PlatformType[] =
          nextTypes[0] === finalType
            ? nextTypes
            : [finalType, ...nextTypes.filter((p) => p !== finalType)];
        updateData.types = JSON.stringify(aligned);
        // type 字段未显式传入但对齐后首项变了 → 同步更新 type 保持不变量
        if (body.type === undefined && aligned[0] !== existing.type) {
          updateData.type = aligned[0];
        }
      }
    } else if (body.type !== undefined && body.type !== existing.type) {
      // 客户端 PUT 仅改 type 不传 types：必须强制重写 types 把新 type 提到首项，
      // 否则 types 与 type 不一致（如 type=gemini + types=["openai"]），router 会把
      // 「首选协议声明 gemini」的请求发到 openai 兼容上游。修复契约违反的关键路径。
      // 复用库中 types 的其余协议，只把 finalType 提到首项。
      const existingTypes = resolvePlatformProtocols(existing.types ?? null, existing.type as PlatformType);
      const aligned: PlatformType[] = [
        finalType,
        ...existingTypes.filter((p) => p !== finalType),
      ];
      updateData.types = JSON.stringify(aligned);
    }
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
          if (!Array.isArray(parsed)) {
            errors.push("forwardHeaders 必须是 JSON 数组");
          } else {
            const validHeaders = parsed
              .filter(
                (h: unknown): h is string =>
                  typeof h === "string" && h.trim().length > 0
              )
              .map((h: string) => h.trim());
            updateData.forwardHeaders = JSON.stringify(validHeaders);
          }
        } catch {
          errors.push("forwardHeaders 必须是合法的 JSON 数组");
        }
      } else {
        errors.push("forwardHeaders 必须是字符串");
      }
    }

    // 高级设置：UA 复用
    if (body.reuseUserAgent !== undefined) {
      updateData.reuseUserAgent = !!body.reuseUserAgent;
    }
    if (body.customUserAgent !== undefined) {
      if (typeof body.customUserAgent !== "string") {
        errors.push("自定义 User-Agent 必须为字符串");
      } else if (body.customUserAgent.trim().length > 0 && body.customUserAgent.length > 500) {
        errors.push("自定义 User-Agent 不能超过 500 个字符");
      } else if (body.customUserAgent.trim().length === 0) {
        updateData.customUserAgent = null;
      } else {
        updateData.customUserAgent = body.customUserAgent.trim();
      }
    }

    // 高级设置：自定义请求头（强制覆盖），JSON 键值对
    if (body.extraHeaders !== undefined) {
      if (body.extraHeaders === "" || body.extraHeaders === null) {
        updateData.extraHeaders = "{}";
      } else if (typeof body.extraHeaders === "string") {
        try {
          const parsed = JSON.parse(body.extraHeaders);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            errors.push("extraHeaders 必须是 JSON 键值对对象");
          } else {
            const normalized: Record<string, string> = {};
            let count = 0;
            for (const [k, v] of Object.entries(parsed)) {
              if (count >= 20) break;
              if (typeof k !== "string" || typeof v !== "string") continue;
              normalized[k] = v;
              count++;
            }
            updateData.extraHeaders = JSON.stringify(normalized);
          }
        } catch {
          errors.push("extraHeaders 必须是合法的 JSON 对象");
        }
      } else {
        errors.push("extraHeaders 必须是字符串");
      }
    }

    // apiKeys 在编辑时可选（不提供则保留原值）
    // 支持两种格式：字符串数组 ["key1", "key2"] 或对象数组 [{name, key, whitelisted}]
    if (body.apiKeys !== undefined && body.apiKeys !== null) {
      // 兼容直接传数组的客户端：统一转 JSON 字符串后解析
      const rawApiKeys =
        typeof body.apiKeys === "string" ? body.apiKeys : JSON.stringify(body.apiKeys);
      // 空串/纯空白串守卫：与创建端 POST 对齐（POST 对 trim 后为空的 apiKeys
      // 显式 400）。此前空串直接置 [] 落库并返回 200——静默清空平台全部密钥
      // 且假成功，v1 路由对该平台将无 Key 可用
      if (typeof rawApiKeys === "string" && rawApiKeys.trim() === "") {
        errors.push("API 密钥不能为空");
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawApiKeys);
        } catch {
          errors.push("apiKeys 必须是合法的 JSON 数组");
          parsed = null;
        }
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
                if (Array.isArray(k.proxyUrls)) {
                  const urls = (k.proxyUrls as unknown[]).filter((u): u is string => typeof u === "string" && u.trim().length > 0).slice(0, 2);
                  if (urls.length > 0) obj.proxyUrls = urls;
                }
                if (k.proxyStrict === false) obj.proxyStrict = false;
                return obj;
              });
            // 空集守卫：与创建端 POST 对齐（POST 对解析后无有效密钥统一返回
            // 「API 密钥不能为空」400，同样拒绝显式 []）。否则畸形载荷
            // （如 [{"key":" "}]）会静默清空平台全部密钥并假成功，
            // v1 路由对该平台将无 Key 可用
            if (validKeys.length === 0) {
              errors.push("API 密钥不能为空");
            } else {
              updateData.apiKeys = JSON.stringify(validKeys);
            }
          } else {
            // 旧格式：字符串数组
            const validKeys = parsed.filter(
              (k: unknown): k is string =>
                typeof k === "string" &&
                k.trim().length > 0 &&
                k.length <= 500
            );
            // 空集守卫：同上，与 POST「API 密钥不能为空」语义一致
            if (validKeys.length === 0) {
              errors.push("API 密钥不能为空");
            } else {
              updateData.apiKeys = JSON.stringify(validKeys);
            }
          }
        } else if (parsed !== null) {
          errors.push("apiKeys 必须是 JSON 数组");
        }
      }
    }

    // JSON 字段校验失败时返回错误，不做静默保留
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join("; ") });
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

    // 解禁（status=healthy）时强制清零失败计数并同步清内存熔断条目，
    // 使解禁立即生效——否则内存 breaker 仍 open，最长 30s（缓存 TTL）后
    // 才被 syncCircuitBreakersFromDatabase 清除，期间请求仍被 selectPlatform 拦截。
    // 同时强制清 cooldownEnd：API 直调 {status:"healthy", cooldownEnd:<未来>} 时
    // 若保留旧值，selectPlatform 会继续排除该平台直到冷却自然到期，与「已解禁」
    // 预期相反（前端总是同时提交 null，此处对 API 层兜底）
    if (updateData.status === "healthy") {
      updateData.failCount = 0;
      updateData.cooldownEnd = null;
      resetCircuitBreaker(id);
    }

    await db.platforms.update({ where: { id }, data: updateData });
    invalidateRouterCache();
    invalidateApiKeyCache();

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
        ip: getClientIp(req),
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
 * 清理关联的请求日志、每日统计和平台模型
 */
async function handleDelete(req: NextApiRequest, res: NextApiResponse, id: string) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }
  if (!checkCsrfOrigin(req, res)) return;
  if (!(await checkAdminRateLimit(admin.adminId, res))) return;

  try {
    const db = await createDb();

    // 统计并清理关联数据
    // 删除关联的请求日志
    await db.requestLogs.deleteMany({ where: { platformId: id } });

    // 级联清理每日统计：否则日志已删而 daily_stats 残留，仪表盘历史统计与日志页数据矛盾
    await db.dailyStats.deleteMany({ where: { platformId: id } });

    // 删除关联的平台模型
    await db.platformModels.deleteMany({ where: { platformId: id } });

    // 删除平台本身
    await db.platforms.delete({ where: { id } });
    invalidateRouterCache();

    // 审计日志
    const now = Math.floor(Date.now() / 1000);
    await db.auditLogs.create({
      data: {
        id: newId(),
        adminId: getAuditAdminId(admin),
        action: "delete_platform",
        detail: JSON.stringify({ platformId: id }),
        ip: getClientIp(req),
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
