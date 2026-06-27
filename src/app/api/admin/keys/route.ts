import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import crypto from "crypto";

/**
 * GET /api/admin/keys — 获取 API Key 列表
 */
export async function GET() {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  try {
    const keys = await prisma.apiKey.findMany({
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    });

    // 掩码处理：列表接口不返回完整密钥值
    const maskedKeys = keys.map((k) => ({
      ...k,
      key:
        k.key.length > 12
          ? k.key.substring(0, 8) + "..." + k.key.substring(k.key.length - 4)
          : "***",
    }));

    return NextResponse.json({
      success: true,
      data: maskedKeys,
      total: maskedKeys.length,
    });
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "获取 Key 列表失败",
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/keys — 创建 API Key
 */
export async function POST(request: NextRequest) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  try {
    const body = await request.json();
    const {
      name,
      planId,
      quota,
      rpmLimit,
      tpmLimit,
      callLimit,
      tokenLimit,
      resetPeriod,
      expiresAt,
    } = body;

    if (!name) {
      return NextResponse.json(
        { success: false, error: "Key 名称不能为空" },
        { status: 400 }
      );
    }

    if (typeof name === "string" && name.length > 100) {
      return NextResponse.json(
        { success: false, error: "Key 名称不能超过 100 个字符" },
        { status: 400 }
      );
    }

    // 验证 expiresAt 是否为有效日期
    let expiresAtDate: Date | null = null;
    if (expiresAt) {
      const parsed = new Date(expiresAt);
      if (isNaN(parsed.getTime())) {
        return NextResponse.json(
          { success: false, error: "expiresAt 日期格式无效" },
          { status: 400 }
        );
      }
      expiresAtDate = parsed;
    }

    // 生成唯一 Key
    const key = `sk-${crypto.randomBytes(24).toString("hex")}`;

    const apiKey = await prisma.apiKey.create({
      data: {
        key,
        name,
        planId: planId ?? null,
        quota: quota ?? null,
        rpmLimit: rpmLimit ?? null,
        tpmLimit: tpmLimit ?? null,
        callLimit: callLimit ?? null,
        tokenLimit: tokenLimit ?? null,
        resetPeriod: resetPeriod || "monthly",
        expiresAt: expiresAtDate,
      },
    });

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "create_api_key",
        detail: JSON.stringify({ keyId: apiKey.id, name }),
        ip: request.headers.get("x-forwarded-for") || null,
      },
    });

    return NextResponse.json({
      success: true,
      data: apiKey,
      message: "API Key 创建成功",
    });
  } catch (err) {
    console.error("[POST /api/admin/keys] 创建 Key 失败:", err);
    return NextResponse.json(
      {
        success: false,
        error: "创建 Key 失败",
      },
      { status: 500 }
    );
  }
}
