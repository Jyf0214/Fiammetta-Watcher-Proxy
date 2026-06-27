import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { forceRefreshRouterCache } from "@/lib/router";
import { validateUrlSafe } from "@/lib/url-validation";

/**
 * PUT /api/admin/platforms/[id] — 更新平台
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  const { id } = await params;

  try {
    const body = await request.json();

    // 字段类型校验
    const errors: string[] = [];

    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      errors.push("enabled 必须为布尔值");
    }

    if (body.weight !== undefined) {
      if (typeof body.weight !== "number" || !Number.isInteger(body.weight) || body.weight <= 0) {
        errors.push("权重必须为正整数");
      }
    }

    if (body.priority !== undefined) {
      if (typeof body.priority !== "number" || !Number.isInteger(body.priority) || body.priority < 0) {
        errors.push("优先级必须为非负整数");
      }
    }

    // SSRF 防护：校验 baseUrl 格式及内网地址黑名单
    if (body.baseUrl !== undefined) {
      if (typeof body.baseUrl !== "string" || body.baseUrl.trim().length === 0) {
        errors.push("基础 URL 不能为空");
      } else {
        const urlCheck = validateUrlSafe(body.baseUrl);
        if (!urlCheck.valid) {
          errors.push(urlCheck.error!);
        }
      }
    }

    const VALID_PLATFORM_TYPES = ["openai", "azure", "custom"] as const;
    if (body.type !== undefined && !VALID_PLATFORM_TYPES.includes(body.type)) {
      errors.push(
        `平台类型无效，允许的值为: ${VALID_PLATFORM_TYPES.join(", ")}`
      );
    }

    if (body.name !== undefined && typeof body.name === "string" && body.name.length > 100) {
      errors.push("平台名称不能超过 100 个字符");
    }

    if (body.apiKey !== undefined && typeof body.apiKey === "string" && body.apiKey.length > 500) {
      errors.push("API Key 不能超过 500 个字符");
    }

    if (errors.length > 0) {
      return NextResponse.json(
        { success: false, error: errors.join("; ") },
        { status: 400 }
      );
    }

    const platform = await prisma.platform.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.baseUrl !== undefined && { baseUrl: body.baseUrl }),
        ...(body.apiKey !== undefined && { apiKey: body.apiKey }),
        ...(body.type !== undefined && { type: body.type }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        ...(body.priority !== undefined && { priority: body.priority }),
        ...(body.weight !== undefined && { weight: body.weight }),
        ...(body.rpmLimit !== undefined && { rpmLimit: body.rpmLimit ?? null }),
        ...(body.tpmLimit !== undefined && { tpmLimit: body.tpmLimit ?? null }),
      },
    });

    await forceRefreshRouterCache();

    // 脱敏处理 - 移除敏感字段
    const sanitized = { ...body };
    if (sanitized.apiKey) sanitized.apiKey = sanitized.apiKey.substring(0, 6) + "***";

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "update_platform",
        detail: JSON.stringify({ platformId: id, changes: sanitized }),
        ip: request.headers.get("x-forwarded-for") || null,
      },
    });

    // 排除 apiKey 明文，避免敏感信息泄露到前端
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKey: _, ...safePlatform } = platform;

    return NextResponse.json({
      success: true,
      data: safePlatform,
      message: "平台更新成功",
    });
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "更新平台失败",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/platforms/[id] — 删除平台
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  const { id } = await params;

  try {
    // 检查是否存在关联的 ModelMap 记录
    const relatedModels = await prisma.modelMap.findMany({
      where: { platformId: id },
    });
    if (relatedModels.length > 0) {
      return NextResponse.json(
        {
          error: `该平台被 ${relatedModels.length} 个模型映射引用，无法删除。请先删除相关映射。`,
        },
        { status: 400 }
      );
    }

    await prisma.platform.delete({ where: { id } });

    await forceRefreshRouterCache();

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "delete_platform",
        detail: JSON.stringify({ platformId: id }),
        ip: request.headers.get("x-forwarded-for") || null,
      },
    });

    return NextResponse.json({
      success: true,
      message: "平台删除成功",
    });
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "删除平台失败",
      },
      { status: 500 }
    );
  }
}
