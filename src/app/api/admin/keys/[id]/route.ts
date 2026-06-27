import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

/** BigInt → string，防止 JSON.stringify 报错 */
function serializeKey(k: Record<string, unknown>) {
  return { ...k, usedTokens: String(k.usedTokens ?? 0) };
}

/**
 * PUT /api/admin/keys/[id] — 更新 API Key 属性
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
    // 检查 Key 是否存在
    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "API Key 不存在" },
        { status: 404 }
      );
    }

    const body = await request.json();

    // 数值类型校验
    const numericFields = ["quota", "rpmLimit", "tpmLimit", "callLimit"] as const;
    for (const field of numericFields) {
      if (body[field] !== undefined && body[field] !== null) {
        if (typeof body[field] !== "number" || !Number.isFinite(body[field])) {
          return NextResponse.json(
            { success: false, error: `${field} 必须是有效数字` },
            { status: 400 }
          );
        }
      }
    }

    // tokenLimit 为 BigInt 类型，单独校验
    if (body.tokenLimit !== undefined && body.tokenLimit !== null) {
      if (typeof body.tokenLimit !== "number" || !Number.isFinite(body.tokenLimit)) {
        return NextResponse.json(
          { success: false, error: "tokenLimit 必须是有效数字" },
          { status: 400 }
        );
      }
      if (!Number.isInteger(body.tokenLimit) || body.tokenLimit < 0) {
        return NextResponse.json(
          { success: false, error: "tokenLimit 必须是非负整数" },
          { status: 400 }
        );
      }
    }

    // name 长度校验
    if (body.name !== undefined && typeof body.name === "string" && body.name.length > 100) {
      return NextResponse.json(
        { success: false, error: "Key 名称不能超过 100 个字符" },
        { status: 400 }
      );
    }

    // status 校验
    if (body.status !== undefined) {
      const allowedStatuses = ["active", "disabled", "expired"];
      if (!allowedStatuses.includes(body.status)) {
        return NextResponse.json(
          { success: false, error: `status 无效，允许值：${allowedStatuses.join(", ")}` },
          { status: 400 }
        );
      }
    }

    // planId 外键存在性校验
    if (body.planId !== undefined) {
      if (body.planId !== null) {
        const planExists = await prisma.plan.findUnique({
          where: { id: body.planId },
        });
        if (!planExists) {
          return NextResponse.json(
            { success: false, error: "指定的 planId 对应的套餐不存在" },
            { status: 400 }
          );
        }
      }
    }

    // expiresAt 日期校验
    let expiresAtDate: Date | null | undefined;
    if (body.expiresAt !== undefined) {
      if (body.expiresAt === null) {
        expiresAtDate = null;
      } else {
        const parsed = new Date(body.expiresAt);
        if (isNaN(parsed.getTime())) {
          return NextResponse.json(
            { success: false, error: "expiresAt 日期格式无效" },
            { status: 400 }
          );
        }
        expiresAtDate = parsed;
      }
    }

    const updated = await prisma.apiKey.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.planId !== undefined && { planId: body.planId ?? null }),
        ...(body.quota !== undefined && { quota: body.quota ?? null }),
        ...(body.rpmLimit !== undefined && { rpmLimit: body.rpmLimit ?? null }),
        ...(body.tpmLimit !== undefined && { tpmLimit: body.tpmLimit ?? null }),
        ...(body.callLimit !== undefined && { callLimit: body.callLimit ?? null }),
        ...(body.tokenLimit !== undefined && {
          tokenLimit: body.tokenLimit !== null ? BigInt(body.tokenLimit) : null,
        }),
        ...(body.resetPeriod !== undefined && { resetPeriod: body.resetPeriod }),
        ...(body.status !== undefined && { status: body.status }),
        ...(expiresAtDate !== undefined && { expiresAt: expiresAtDate }),
      },
    });

    // 脱敏处理 - 移除敏感字段
    const sanitized = { ...body };
    if (sanitized.key) sanitized.key = sanitized.key.substring(0, 8) + "***";

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "update_api_key",
        detail: JSON.stringify({ keyId: id, changes: sanitized }),
        ip: request.headers.get("x-forwarded-for") || null,
      },
    });

    return NextResponse.json({
      success: true,
      data: serializeKey(updated),
      message: "API Key 更新成功",
    });
  } catch (err) {
    console.error("[PUT /api/admin/keys/[id]] 更新失败:", err);
    return NextResponse.json(
      {
        success: false,
        error: "更新 API Key 失败",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/keys/[id] — 删除 API Key
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
    // 检查 Key 是否存在
    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "API Key 不存在" },
        { status: 404 }
      );
    }

    // 检查关联的请求日志数量
    const logCount = await prisma.requestLog.count({
      where: { keyId: id },
    });

    if (logCount > 0) {
      // 存在关联日志，级联删除
      await prisma.requestLog.deleteMany({ where: { keyId: id } });
    }

    await prisma.apiKey.delete({ where: { id } });

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "delete_api_key",
        detail: JSON.stringify({ keyId: id, name: existing.name, deletedLogs: logCount }),
        ip: request.headers.get("x-forwarded-for") || null,
      },
    });

    return NextResponse.json({
      success: true,
      message: "API Key 删除成功",
      deletedLogs: logCount,
    });
  } catch (err) {
    console.error("[DELETE /api/admin/keys/[id]] 删除失败:", err);
    return NextResponse.json(
      {
        success: false,
        error: "删除 API Key 失败",
      },
      { status: 500 }
    );
  }
}
