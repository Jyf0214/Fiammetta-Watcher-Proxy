import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { forceRefreshRouterCache } from "@/lib/router";
import { validateUrlSafe } from "@/lib/url-validation";
import { serializeApiKeys } from "@/lib/platform-keys";
import { isDebug } from "@/lib/auth-helpers";

/**
 * 验证管理员身份的通用守卫
 */
async function requireAdmin() {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return null;
  }
  return admin;
}

/**
 * GET /api/admin/platforms — 获取平台列表
 */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  try {
    const platforms = await prisma.platform.findMany({
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        name: true,
        baseUrl: true,
        type: true,
        enabled: true,
        priority: true,
        weight: true,
        rpmLimit: true,
        tpmLimit: true,
        status: true,
        failCount: true,
        lastFailAt: true,
        cooldownEnd: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({
      success: true,
      data: platforms,
      total: platforms.length,
    });
  } catch (err) {
    console.error("[GET /api/admin/platforms] 获取平台列表失败:", err);
    return NextResponse.json(
      {
        success: false,
        error: "获取平台列表失败",
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/platforms — 创建平台
 */
export async function POST(request: NextRequest) {
  if (isDebug) console.log("[POST /api/admin/platforms] 收到创建请求");
  const admin = await requireAdmin();
  if (!admin) {
    if (isDebug) console.log("[POST /api/admin/platforms] 未授权");
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    if (isDebug) console.log("[POST /api/admin/platforms] 请求体:", { ...body, apiKey: body.apiKey ? "***" : undefined });
    const { name, baseUrl, apiKey, apiKeys, type, priority, weight, rpmLimit, tpmLimit, forwardHeaders } =
      body;

    // 输入校验
    const errors: string[] = [];

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      errors.push("平台名称不能为空");
    }

    if (!baseUrl || typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
      errors.push("基础 URL 不能为空");
    } else {
      // SSRF 防护：校验 URL 格式及内网地址黑名单
      const urlCheck = validateUrlSafe(baseUrl);
      if (!urlCheck.valid) {
        errors.push(urlCheck.error!);
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
            parsedApiKeys = parsed.filter((k: unknown): k is string =>
              typeof k === "string" && k.trim().length > 0 && k.length <= 500
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
      if (typeof weight !== "number" || !Number.isInteger(weight) || weight <= 0) {
        errors.push("权重必须为正整数");
      }
    }

    // priority 校验
    if (body.priority !== undefined && body.priority !== null) {
      if (typeof body.priority !== "number" || !Number.isInteger(body.priority) || body.priority < 0) {
        errors.push("优先级必须是非负整数");
      }
    }
    // rpmLimit 校验
    if (body.rpmLimit !== undefined && body.rpmLimit !== null) {
      if (typeof body.rpmLimit !== "number" || !Number.isFinite(body.rpmLimit) || body.rpmLimit < 0) {
        errors.push("RPM 限制必须是非负数");
      }
    }
    // tpmLimit 校验
    if (body.tpmLimit !== undefined && body.tpmLimit !== null) {
      if (typeof body.tpmLimit !== "number" || !Number.isFinite(body.tpmLimit) || body.tpmLimit < 0) {
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
              .filter((h: unknown): h is string => typeof h === "string" && h.trim().length > 0)
              .map((h: string) => h.trim());
            normalizedForwardHeaders = JSON.stringify(validHeaders);
          }
        } catch {
          errors.push("透传请求头 JSON 格式错误");
        }
      }
    }

    if (errors.length > 0) {
      if (isDebug) console.log("[POST /api/admin/platforms] 校验失败:", errors);
      return NextResponse.json(
        { success: false, error: errors.join("; ") },
        { status: 400 }
      );
    }

    const platformType = VALID_PLATFORM_TYPES.includes(type) ? type : "openai";

    if (isDebug) {
      console.log("[DEBUG] 创建平台:", { name, baseUrl, type: platformType, priority, weight, rpmLimit, tpmLimit });
    }

    const platform = await prisma.platform.create({
      data: {
        name,
        baseUrl,
        apiKey,
        apiKeys: serializeApiKeys(parsedApiKeys),
        type: platformType,
        priority: priority ?? 0,
        weight: weight ?? 1,
        rpmLimit: rpmLimit ?? null,
        tpmLimit: tpmLimit ?? null,
        forwardHeaders: normalizedForwardHeaders,
      },
    });

    // 审计日志
    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "create_platform",
        detail: JSON.stringify({ platformId: platform.id, name }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    forceRefreshRouterCache();

    if (isDebug) console.log("[POST /api/admin/platforms] 创建成功:", { id: platform.id, name: platform.name });

    // 排除 apiKey 明文，避免敏感信息泄露到前端
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKey: _, ...safePlatform } = platform;

    return NextResponse.json({
      success: true,
      data: safePlatform,
      message: "平台创建成功",
    });
  } catch (err) {
    console.error("[POST /api/admin/platforms] 创建平台失败:", err);
    return NextResponse.json(
      {
        success: false,
        error: "创建平台失败",
      },
      { status: 500 }
    );
  }
}
