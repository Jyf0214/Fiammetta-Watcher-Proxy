import { NextResponse, NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { serializeBigInt } from "@/lib/serialize";
import { isDebug } from "@/lib/auth-helpers";
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
      ...serializeBigInt(k),
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
  } catch (err) {
    console.error("[GET /api/admin/keys] 获取 Key 列表失败:", err);
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

    // resetPeriod 枚举校验
    const validResetPeriods = ["monthly", "daily", "never"];
    if (resetPeriod && !validResetPeriods.includes(resetPeriod)) {
      return NextResponse.json({ success: false, error: "重置周期必须是 monthly、daily 或 never" }, { status: 400 });
    }
    // 数值字段校验
    if (quota !== undefined && quota !== null && (typeof quota !== "number" || !Number.isFinite(quota) || quota < 0)) {
      return NextResponse.json({ success: false, error: "配额必须是非负数" }, { status: 400 });
    }
    if (body.rpmLimit !== undefined && body.rpmLimit !== null && (typeof body.rpmLimit !== "number" || !Number.isFinite(body.rpmLimit) || body.rpmLimit < 0)) {
      return NextResponse.json({ success: false, error: "RPM 限制必须是非负数" }, { status: 400 });
    }
    if (body.tpmLimit !== undefined && body.tpmLimit !== null && (typeof body.tpmLimit !== "number" || !Number.isFinite(body.tpmLimit) || body.tpmLimit < 0)) {
      return NextResponse.json({ success: false, error: "TPM 限制必须是非负数" }, { status: 400 });
    }
    if (body.callLimit !== undefined && body.callLimit !== null && (typeof body.callLimit !== "number" || !Number.isFinite(body.callLimit) || body.callLimit < 0)) {
      return NextResponse.json({ success: false, error: "调用次数限制必须是非负数" }, { status: 400 });
    }
    if (body.tokenLimit !== undefined && body.tokenLimit !== null && (typeof body.tokenLimit !== "number" || !Number.isInteger(body.tokenLimit) || body.tokenLimit < 0)) {
      return NextResponse.json({ success: false, error: "Token 限制必须是非负整数" }, { status: 400 });
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

    if (isDebug) {
      console.log("[DEBUG] 创建 API Key:", { name, planId, quota, rpmLimit, tpmLimit, callLimit, tokenLimit, resetPeriod, expiresAt });
    }

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
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    return NextResponse.json({
      success: true,
      data: serializeBigInt(apiKey),
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
