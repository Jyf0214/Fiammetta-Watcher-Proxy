/**
 * 平台管理 CRUD API — 列表和创建
 *
 * GET  /api/admin/platforms  — 获取平台列表（按优先级倒序、创建时间倒序）
 * POST /api/admin/platforms  — 创建平台（带输入校验和 SSRF 防护）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest, getAuditAdminId } from "@/lib/admin-auth";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import { isSafeUrl, checkCsrfOrigin } from "@/lib/admin-security";
import { readPlatformKeyStatus, type PlatformKeyStatus } from "@/lib/key-status";
import { getKeyStatusesFromMemory, parseApiKeys } from "../../../worker/src/platform-keys";
import { type PlatformType } from "../../../lib/types";
import { getClientIp } from "./auth";

/** 掩码 API 密钥（与 keys.ts 等保持一致） */
function maskKey(key: string): string {
  if (key.length > 12) return key.substring(0, 8) + "..." + key.substring(key.length - 4);
  return "***";
}

/** 列表接口掩码 apiKeys（JSON 数组字符串），避免密钥明文下发到前端 */
function maskApiKeysJson(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return "[]";
    return JSON.stringify(
      parsed.map((k) => {
        if (typeof k === "string") return maskKey(k);
        if (typeof k === "object" && k !== null && typeof (k as { key?: unknown }).key === "string") {
          return { ...k, key: maskKey((k as { key: string }).key) };
        }
        return k;
      })
    );
  } catch {
    // 非 JSON（异常数据）：不下发任何原文
    return "[]";
  }
}

/**
 * GET /api/admin/platforms — 获取平台列表
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const admin = await getAdminFromRequest(req);
    if (!admin) {
      return res.status(401).json({ success: false, error: "未授权" });
    }

    try {
      const db = await createDb();
      const platforms = await db.platforms.findMany({
        orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
        select: {
          id: true, name: true, baseUrl: true, apiKeys: true,
          type: true, types: true, presetId: true, enabled: true, priority: true, weight: true,
          rpmLimit: true, tpmLimit: true, forwardHeaders: true,
          injectStreamOptions: true,
          status: true, failCount: true, lastFailAt: true, cooldownEnd: true,
          createdAt: true, updatedAt: true,
        },
      });

      // 读取 KV 中持久化的密钥状态（封禁/降级），非 Cloudflare 环境容错为空
      let kv: KVNamespace | undefined;
      try {
        const { getCloudflareContext } = await import("@opennextjs/cloudflare");
        kv = getCloudflareContext().env.KV as KVNamespace | undefined;
      } catch {
        // 本地开发或非 Cloudflare 环境没有 KV binding
      }

      const keyStatusesByPlatform: Record<string, PlatformKeyStatus> = {};
      if (kv) {
        await Promise.all(
          platforms.map(async (p) => {
            keyStatusesByPlatform[p.id] = await readPlatformKeyStatus(kv, p.id);
          })
        );
      }
      // 合并同进程内存态（非 Cloudflare 部署：admin 与 v1 路由同 Node 进程，
      // 429 封禁/降级直接读内存；无 KV 时是唯一状态源）
      for (const p of platforms) {
        const memoryStatuses = getKeyStatusesFromMemory(p.id, parseApiKeys(p.apiKeys ?? "[]"));
        keyStatusesByPlatform[p.id] = {
          ...(keyStatusesByPlatform[p.id] ?? {}),
          ...memoryStatuses,
        };
      }

      const data = platforms.map((p) => ({
        ...p,
        // 列表不下发密钥明文（详情编辑回填由 [id].ts 单独提供）
        apiKeys: maskApiKeysJson(p.apiKeys ?? "[]"),
        // 单平台多协议：列表 API 把 types JSON 字符串解析为数组下发，
        // 匹配前端 Platform 接口（types?: string[]）；旧数据/解析失败时回退 [type]
        types: (() => {
          try {
            const parsed = JSON.parse(p.types ?? "[]") as unknown;
            if (Array.isArray(parsed) && parsed.length > 0) {
              return parsed.filter((x): x is string => typeof x === "string");
            }
            return [p.type];
          } catch {
            return [p.type];
          }
        })(),
        keyStatuses: keyStatusesByPlatform[p.id] ?? {},
      }));

      return res.status(200).json({
        success: true,
        data,
        total: platforms.length,
      });
    } catch (err) {
      console.error("[GET /api/admin/platforms] 获取平台列表失败:", err);
      return res.status(500).json({ success: false, error: "获取平台列表失败" });
    }
  }

  if (req.method === "POST") {
    const admin = await getAdminFromRequest(req);
    if (!admin) {
      return res.status(401).json({ success: false, error: "未授权" });
    }
    if (!checkCsrfOrigin(req, res)) return;
    if (!await checkAdminRateLimit(admin.adminId, res)) return;

    try {
      const body: any = req.body;
      const {
        name,
        baseUrl,
        apiKeys,
        type,
        priority,
        weight,
        rpmLimit,
        tpmLimit,
        forwardHeaders,
        injectStreamOptions,
        whitelisted,
        extraHeaders,
        reuseUserAgent,
        customUserAgent,
      } = body;

      // 输入校验
      const errors: string[] = [];

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        errors.push("平台名称不能为空");
      }

      if (!baseUrl || typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
        errors.push("基础 URL 不能为空");
      } else {
        // SSRF 防护（含 DNS Rebinding 检测）
        const urlCheck = await isSafeUrl(baseUrl);
        if (!urlCheck.safe) {
          errors.push(urlCheck.reason || "URL 不安全");
        }
      }

      if (name && typeof name === "string" && name.length > 100) {
        errors.push("平台名称不能超过 100 个字符");
      }

      // apiKeys 验证：JSON 数组格式（命名对象 [{name, key, whitelisted}] 或字符串数组），
      // 至少包含一个有效密钥，保留 name/whitelisted 标记
      const parsedApiKeys: { name: string; key: string; whitelisted?: boolean }[] = [];
      if (!apiKeys || typeof apiKeys !== "string" || apiKeys.trim().length === 0) {
        errors.push("API 密钥不能为空");
      } else {
        try {
          const parsed = JSON.parse(apiKeys);
          if (!Array.isArray(parsed)) {
            errors.push("API 密钥必须为数组格式");
          } else {
            let invalidCount = 0;
            for (const k of parsed) {
              if (typeof k === "string") {
                if (k.trim().length > 0 && k.length <= 500) {
                  parsedApiKeys.push({ name: `密钥${parsedApiKeys.length + 1}`, key: k.trim() });
                } else {
                  invalidCount++;
                }
              } else if (typeof k === "object" && k !== null && typeof k.key === "string") {
                if (k.key.trim().length > 0 && k.key.length <= 500) {
                  const obj: { name: string; key: string; whitelisted?: boolean; enabled?: boolean; errorCount?: number; proxyUrls?: string[]; proxyStrict?: boolean } = {
                    name: typeof k.name === "string" && k.name.trim() ? k.name.trim() : `密钥${parsedApiKeys.length + 1}`,
                    key: k.key.trim(),
                  };
                  if (k.whitelisted === true) obj.whitelisted = true;
                  if (k.enabled === false) obj.enabled = false;
                  if (typeof k.errorCount === "number" && k.errorCount > 0) obj.errorCount = k.errorCount;
                  // 与 PUT 分支对齐：密钥级出站代理绑定与严格模式在创建时同样落库，
                  // 否则新建平台时绑定的代理静默丢失且返回 200 假成功
                  if (Array.isArray(k.proxyUrls)) {
                    const urls = (k.proxyUrls as unknown[]).filter((u): u is string => typeof u === "string" && u.trim().length > 0).slice(0, 2);
                    if (urls.length > 0) obj.proxyUrls = urls;
                  }
                  if (k.proxyStrict === false) obj.proxyStrict = false;
                  parsedApiKeys.push(obj);
                } else {
                  invalidCount++;
                }
              } else {
                invalidCount++;
              }
            }
            if (parsedApiKeys.length === 0) {
              errors.push("API 密钥不能为空");
            } else if (invalidCount > 0) {
              errors.push("部分密钥格式无效或超过 500 字符，已自动过滤");
            }
          }
        } catch {
          errors.push("API 密钥 JSON 格式错误");
        }
      }

      const VALID_PLATFORM_TYPES = ["openai", "azure", "custom", "anthropic", "gemini"] as const;
      if (type !== undefined && !VALID_PLATFORM_TYPES.includes(type)) {
        errors.push(
          `平台类型无效，允许的值为: ${VALID_PLATFORM_TYPES.join(", ")}`
        );
      }


      if (weight !== undefined) {
        if (
          typeof weight !== "number" ||
          !Number.isInteger(weight) ||
          weight <= 0
        ) {
          errors.push("权重必须为正整数");
        }
      }

      if (body.priority !== undefined && body.priority !== null) {
        if (
          typeof body.priority !== "number" ||
          !Number.isInteger(body.priority) ||
          body.priority < 0
        ) {
          errors.push("优先级必须是非负整数");
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

      // forwardHeaders 校验：JSON 字符串数组
      let normalizedForwardHeaders = "[]";
      if (forwardHeaders !== undefined && forwardHeaders !== null && forwardHeaders !== "") {
        if (typeof forwardHeaders !== "string") {
          errors.push("透传请求头必须为 JSON 字符串数组格式");
        } else {
          try {
            const parsed = JSON.parse(forwardHeaders);
            if (!Array.isArray(parsed)) {
              errors.push("透传请求头必须为数组格式");
            } else {
              const validHeaders = parsed
                .filter(
                  (h: unknown): h is string =>
                    typeof h === "string" && h.trim().length > 0
                )
                .map((h: string) => h.trim());
              normalizedForwardHeaders = JSON.stringify(validHeaders);
            }
          } catch {
            errors.push("透传请求头 JSON 格式错误");
          }
        }
      }

      if (errors.length > 0) {
        return res.status(400).json({ success: false, error: errors.join("; ") });
      }

      // extraHeaders 校验：JSON 对象（键值对），最多 20 条，键与值均为字符串
      let normalizedExtraHeaders = "{}";
      if (extraHeaders !== undefined && extraHeaders !== null && extraHeaders !== "") {
        if (typeof extraHeaders !== "string") {
          errors.push("自定义请求头必须为 JSON 对象字符串");
        } else {
          try {
            const parsed = JSON.parse(extraHeaders);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
              errors.push("自定义请求头必须为 JSON 对象");
            } else {
              const normalized: Record<string, string> = {};
              let count = 0;
              for (const [k, v] of Object.entries(parsed)) {
                if (count >= 20) {
                  errors.push("自定义请求头最多 20 条");
                  break;
                }
                if (typeof k !== "string" || typeof v !== "string") {
                  errors.push("自定义请求头的键和值必须为字符串");
                  break;
                }
                normalized[k] = v;
                count++;
              }
              normalizedExtraHeaders = JSON.stringify(normalized);
            }
          } catch {
            errors.push("自定义请求头 JSON 格式错误");
          }
        }
      }

      // customUserAgent 校验：非空字符串且不超过 500 字符（空串视为清除，与 PUT 一致）
      if (customUserAgent !== undefined && customUserAgent !== null) {
        if (typeof customUserAgent !== "string") {
          errors.push("自定义 User-Agent 必须为字符串");
        } else if (customUserAgent.trim().length > 0 && customUserAgent.length > 500) {
          errors.push("自定义 User-Agent 不能超过 500 个字符");
        }
      }

      if (errors.length > 0) {
        return res.status(400).json({ success: false, error: errors.join("; ") });
      }

      const platformType = VALID_PLATFORM_TYPES.includes(type) ? type : "openai";

      // 单平台多协议：types 字段是字符串数组，首项必须 === type（首选协议同步）。
      // 兼容旧请求：types 缺失/非数组 → 视为 [type]，不报错；非法元素被静默过滤。
      // 入参形态可以是数组本身（API JSON）或 JSON 字符串（表单回退）。
      let normalizedTypes: PlatformType[] = [];
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
        for (const item of arr) {
          if (VALID_PLATFORM_TYPES.includes(item as PlatformType)) {
            const p = item as PlatformType;
            if (!normalizedTypes.includes(p)) normalizedTypes.push(p);
          }
        }
        if (normalizedTypes.length === 0) {
          // 整组非法/非数组：与缺失同语义，回退到 [type]
          normalizedTypes = [platformType];
        }
        // 首选协议对齐：首项必须等于最终生效的 type
        if (normalizedTypes[0] !== platformType) {
          normalizedTypes = [
            platformType,
            ...normalizedTypes.filter((p) => p !== platformType),
          ];
        }
      } else {
        normalizedTypes = [platformType];
      }
      const now = Math.floor(Date.now() / 1000);
      // 与 PUT 消费一致：reuseUserAgent 布尔化，customUserAgent 空串归一为 null
      const normalizedReuseUserAgent = reuseUserAgent === true;
      const normalizedCustomUserAgent =
        typeof customUserAgent === "string" && customUserAgent.trim().length > 0
          ? customUserAgent.trim()
          : null;

      // 生成唯一 ID，create 与审计 detail 共用同一预生成值
      const id = crypto.randomUUID();

      const db = await createDb();

      // 审计日志：审计先于写入（与 config.ts 一致）——审计写入失败时主流程
      // 抛错返回 500，平台不会落库，避免「平台已创建但无审计」的假成功
      // （TiDB HTTP 适配器下 $transaction 不可依赖，改为按顺序先审计后写入）
      await db.auditLogs.create({
        data: {
          id: crypto.randomUUID(),
          adminId: getAuditAdminId(admin),
          action: "create_platform",
          detail: JSON.stringify({ platformId: id, name }),
          ip: getClientIp(req),
          createdAt: now,
        },
      });

      // 写入数据库（Prisma camelCase 属性名）
      // 注意：name 只做 trim，不做 escapeHtml——React 前端渲染会自动转义，
      // 存库转义会导致 "AT&T" 显示为 "AT&amp;T"，再次保存再转义形成不可逆累积损坏
      await db.platforms.create({
        data: {
          id,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          apiKeys: JSON.stringify(parsedApiKeys),
          type: platformType,
          types: JSON.stringify(normalizedTypes),
          enabled: true,
          priority: priority ?? 0,
          weight: weight ?? 1,
          rpmLimit: rpmLimit ?? null,
          tpmLimit: tpmLimit ?? null,
          status: "healthy",
          failCount: 0,
          forwardHeaders: normalizedForwardHeaders,
          injectStreamOptions: injectStreamOptions !== false,
          whitelisted: whitelisted === true,
          extraHeaders: normalizedExtraHeaders,
          reuseUserAgent: normalizedReuseUserAgent,
          customUserAgent: normalizedCustomUserAgent,
          createdAt: now,
          updatedAt: now,
        },
      });

      return res.status(200).json({
        success: true,
        data: {
          id,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          type: platformType,
          types: normalizedTypes,
          enabled: true,
          priority: priority ?? 0,
          weight: weight ?? 1,
          rpmLimit: rpmLimit ?? null,
          tpmLimit: tpmLimit ?? null,
          status: "healthy",
          failCount: 0,
          forwardHeaders: normalizedForwardHeaders,
          injectStreamOptions: injectStreamOptions !== false,
          extraHeaders: normalizedExtraHeaders,
          reuseUserAgent: normalizedReuseUserAgent,
          customUserAgent: normalizedCustomUserAgent,
          createdAt: now,
          updatedAt: now,
        },
        message: "平台创建成功",
      });
    } catch (err) {
      console.error("[POST /api/admin/platforms] 创建平台失败:", err);
      return res.status(500).json({ success: false, error: "创建平台失败" });
    }
  }

  // 不支持的 HTTP 方法
  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ success: false, error: "方法不允许" });
}
