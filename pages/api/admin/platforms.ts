/**
 * 平台管理 CRUD API — 列表和创建
 *
 * GET  /api/admin/platforms  — 获取平台列表（按优先级倒序、创建时间倒序）
 * POST /api/admin/platforms  — 创建平台（带输入校验和 SSRF 防护）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/db";
import { verifyToken } from "@/lib/auth";
import * as schema from "@/lib/schema";
import { eq, desc } from "drizzle-orm";


/**
 * 验证管理员身份的通用守卫
 */
async function requireAdmin(req: NextApiRequest) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7);
  try {
    const payload = await verifyToken(token, process.env.JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}

/**
 * GET /api/admin/platforms — 获取平台列表
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === "GET") {
    const admin = await requireAdmin(req);
    if (!admin) {
      return res.status(401).json({ success: false, error: "未授权" });
    }

    try {
      const db = createDb((process.env as unknown as { DB: D1Database }).DB);
      const platforms = await db
        .select({
          id: schema.platforms.id,
          name: schema.platforms.name,
          baseUrl: schema.platforms.baseUrl,
          type: schema.platforms.type,
          enabled: schema.platforms.enabled,
          priority: schema.platforms.priority,
          weight: schema.platforms.weight,
          rpmLimit: schema.platforms.rpmLimit,
          tpmLimit: schema.platforms.tpmLimit,
          status: schema.platforms.status,
          failCount: schema.platforms.failCount,
          lastFailAt: schema.platforms.lastFailAt,
          cooldownEnd: schema.platforms.cooldownEnd,
          createdAt: schema.platforms.createdAt,
          updatedAt: schema.platforms.updatedAt,
        })
        .from(schema.platforms)
        .orderBy(desc(schema.platforms.priority), desc(schema.platforms.createdAt));

      return res.status(200).json({
        success: true,
        data: platforms,
        total: platforms.length,
      });
    } catch (err) {
      console.error("[GET /api/admin/platforms] 获取平台列表失败:", err);
      return res.status(500).json({ success: false, error: "获取平台列表失败" });
    }
  }

  if (req.method === "POST") {
    const admin = await requireAdmin(req);
    if (!admin) {
      return res.status(401).json({ success: false, error: "未授权" });
    }

    try {
      const body: any = req.body;
      const {
        name,
        baseUrl,
        apiKey,
        apiKeys,
        type,
        priority,
        weight,
        rpmLimit,
        tpmLimit,
        forwardHeaders,
      } = body;

      // 输入校验
      const errors: string[] = [];

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        errors.push("平台名称不能为空");
      }

      if (!baseUrl || typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
        errors.push("基础 URL 不能为空");
      } else {
        // SSRF 防护：校验 URL 格式及内网地址黑名单
        try {
          const url = new URL(baseUrl);
          if (!["http:", "https:"].includes(url.protocol)) {
            errors.push("URL 协议必须是 http 或 https");
          }
          const hostname = url.hostname;
          // 内网地址黑名单
          if (
            hostname === "localhost" ||
            hostname === "0.0.0.0" ||
            hostname === "127.0.0.1" ||
            /^10\./.test(hostname) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
            /^192\.168\./.test(hostname) ||
            /^169\.254\./.test(hostname) ||
            hostname === "[::1]" ||
            hostname === "::1"
          ) {
            errors.push("URL 不能指向内网或本地地址");
          }
        } catch {
          errors.push("URL 格式不合法");
        }
      }

      if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length === 0) {
        errors.push("API Key 不能为空");
      }

      if (name && typeof name === "string" && name.length > 100) {
        errors.push("平台名称不能超过 100 个字符");
      }

      if (apiKey && typeof apiKey === "string" && apiKey.length > 500) {
        errors.push("API Key 不能超过 500 个字符");
      }

      // apiKeys 验证：JSON 数组格式，每个密钥不超过 500 字符
      let parsedApiKeys: string[] = [];
      if (apiKeys !== undefined && apiKeys !== null && apiKeys !== "") {
        if (typeof apiKeys !== "string") {
          errors.push("附加密钥必须为字符串数组格式");
        } else {
          try {
            const parsed = JSON.parse(apiKeys);
            if (!Array.isArray(parsed)) {
              errors.push("附加密钥必须为数组格式");
            } else {
              parsedApiKeys = parsed.filter(
                (k: unknown): k is string =>
                  typeof k === "string" &&
                  k.trim().length > 0 &&
                  k.length <= 500
              );
              if (parsedApiKeys.length !== parsed.length) {
                errors.push("部分附加密钥格式无效或超过 500 字符，已自动过滤");
              }
            }
          } catch {
            errors.push("附加密钥 JSON 格式错误");
          }
        }
      }

      const VALID_PLATFORM_TYPES = ["openai", "azure", "custom"] as const;
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
          !Number.isFinite(body.rpmLimit) ||
          body.rpmLimit < 0
        ) {
          errors.push("RPM 限制必须是非负数");
        }
      }

      if (body.tpmLimit !== undefined && body.tpmLimit !== null) {
        if (
          typeof body.tpmLimit !== "number" ||
          !Number.isFinite(body.tpmLimit) ||
          body.tpmLimit < 0
        ) {
          errors.push("TPM 限制必须是非负数");
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

      const platformType = VALID_PLATFORM_TYPES.includes(type) ? type : "openai";
      const now = Math.floor(Date.now() / 1000);

      // 生成唯一 ID（cuid 格式）
      const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

      const db = createDb((process.env as unknown as { DB: D1Database }).DB);

      // 写入数据库
      await db.insert(schema.platforms).values({
        id,
        name: name.trim(),
        base_url: baseUrl.trim(),
        api_key: apiKey.trim(),
        api_keys: JSON.stringify(parsedApiKeys),
        type: platformType,
        enabled: 1,
        priority: priority ?? 0,
        weight: weight ?? 1,
        rpm_limit: rpmLimit ?? null,
        tpm_limit: tpmLimit ?? null,
        status: "healthy",
        fail_count: 0,
        forward_headers: normalizedForwardHeaders,
        created_at: now,
        updated_at: now,
      } as any);

      // 审计日志
      await db.insert(schema.auditLogs).values({
        id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        adminId: String((admin as any).adminId || (admin as any).sub || ""),
        action: "create_platform",
        detail: JSON.stringify({ platformId: id, name }),
        ip:
          (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || null,
        createdAt: now,
      } as any);

      return res.status(200).json({
        success: true,
        data: {
          id,
          name: name.trim(),
          base_url: baseUrl.trim(),
          type: platformType,
          enabled: 1,
          priority: priority ?? 0,
          weight: weight ?? 1,
          rpm_limit: rpmLimit ?? null,
          tpm_limit: tpmLimit ?? null,
          status: "healthy",
          fail_count: 0,
          forward_headers: normalizedForwardHeaders,
          created_at: now,
          updated_at: now,
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
