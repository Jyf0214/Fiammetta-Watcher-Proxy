import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { forceRefreshRouterCache } from "@/lib/router";
import { validateUrlSafe } from "@/lib/url-validation";

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
  const admin = await requireAdmin();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    const { name, baseUrl, apiKey, type, priority, weight, rpmLimit, tpmLimit } =
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

    if (errors.length > 0) {
      return NextResponse.json(
        { success: false, error: errors.join("; ") },
        { status: 400 }
      );
    }

    const platformType = VALID_PLATFORM_TYPES.includes(type) ? type : "openai";

    const platform = await prisma.platform.create({
      data: {
        name,
        baseUrl,
        apiKey,
        type: platformType,
        priority: priority ?? 0,
        weight: weight ?? 1,
        rpmLimit: rpmLimit ?? null,
        tpmLimit: tpmLimit ?? null,
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

    return NextResponse.json({
      success: true,
      data: platform,
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
