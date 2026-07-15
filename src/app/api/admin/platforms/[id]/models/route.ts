import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { fetchPlatformModels } from "@/lib/model-fetcher";
import { detectModelType } from "@/lib/model-type";

/**
 * GET /api/admin/platforms/[id]/models — 获取平台的模型列表
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const { id } = await params;

  const models = await prisma.platformModel.findMany({
    where: { platformId: id },
    orderBy: { modelId: "asc" },
  });

  return NextResponse.json({ success: true, data: models });
}

/**
 * POST /api/admin/platforms/[id]/models — 手动添加模型
 * body: { modelId: string, ownedBy?: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json();
  const { modelId, ownedBy } = body;

  if (!modelId || typeof modelId !== "string" || modelId.trim().length === 0) {
    return NextResponse.json(
      { success: false, error: "模型 ID 不能为空" },
      { status: 400 }
    );
  }

  // 检查平台是否存在
  const platform = await prisma.platform.findUnique({ where: { id } });
  if (!platform) {
    return NextResponse.json({ success: false, error: "平台不存在" }, { status: 404 });
  }

  // 检查是否已存在
  const existing = await prisma.platformModel.findUnique({
    where: { platformId_modelId: { platformId: id, modelId: modelId.trim() } },
  });
  if (existing) {
    return NextResponse.json(
      { success: false, error: "该模型已存在" },
      { status: 400 }
    );
  }

  const model = await prisma.platformModel.create({
    data: {
      platformId: id,
      modelId: modelId.trim(),
      ownedBy: ownedBy || platform.name,
      source: "manual",
      type: detectModelType(modelId.trim()),
    },
  });

  return NextResponse.json({ success: true, data: model, message: "模型添加成功" });
}

/**
 * DELETE /api/admin/platforms/[id]/models?modelId=xxx — 删除模型
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const modelId = searchParams.get("modelId");

  if (!modelId) {
    return NextResponse.json({ success: false, error: "缺少 modelId 参数" }, { status: 400 });
  }

  await prisma.platformModel.deleteMany({
    where: { platformId: id, modelId },
  });

  return NextResponse.json({ success: true, message: "模型已删除" });
}

/**
 * PUT /api/admin/platforms/[id]/models — 从远端刷新模型（合并策略）
 *
 * 合并规则：
 * - 新模型（远端有、DB 无）：插入，source = "auto"
 * - 已存在的 auto 模型：更新 fetchedAt
 * - 已存在的 manual 模型：不动
 * - 不再出现在远端的 auto 模型：删除
 */
export async function PUT(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const { id } = await params;

  const platform = await prisma.platform.findUnique({
    where: { id },
    select: { id: true, name: true, baseUrl: true, apiKey: true, apiKeys: true },
  });
  if (!platform) {
    return NextResponse.json({ success: false, error: "平台不存在" }, { status: 404 });
  }

  const upstreamModels = await fetchPlatformModels(platform);
  if (upstreamModels === null) {
    return NextResponse.json(
      { success: false, error: "远端模型拉取失败，请稍后重试" },
      { status: 502 }
    );
  }

  const upstreamIds = new Set(upstreamModels.map((m) => m.id));
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    // 获取当前 DB 中该平台的所有模型
    const existingModels = await tx.platformModel.findMany({
      where: { platformId: id },
    });

    const existingMap = new Map(existingModels.map((m) => [m.modelId, m]));

    // 1. 处理远端存在的模型
    for (const upstream of upstreamModels) {
      const existing = existingMap.get(upstream.id);
      if (existing) {
        // 已存在：更新 auto 模型的 fetchedAt 和 type（校正历史数据），manual 不动
        if (existing.source === "auto") {
          await tx.platformModel.update({
            where: { id: existing.id },
            data: { fetchedAt: now, ownedBy: upstream.owned_by ?? platform.name, type: detectModelType(existing.modelId) },
          });
        }
        // manual 模型：跳过
      } else {
        // 新模型：插入
        await tx.platformModel.create({
          data: {
            platformId: id,
            modelId: upstream.id,
            ownedBy: upstream.owned_by ?? platform.name,
            source: "auto",
            type: detectModelType(upstream.id),
            fetchedAt: now,
          },
        });
      }
    }

    // 2. 删除远端不再存在的 auto 模型（manual 保留）
    for (const existing of existingModels) {
      if (existing.source === "auto" && !upstreamIds.has(existing.modelId)) {
        await tx.platformModel.delete({ where: { id: existing.id } });
      }
    }
  });

  // 统计刷新结果
  const finalCount = await prisma.platformModel.count({ where: { platformId: id } });

  return NextResponse.json({
    success: true,
    data: { total: finalCount, fetched: upstreamModels.length },
    message: `模型刷新完成，当前共 ${finalCount} 个模型`,
  });
}

/**
 * PATCH /api/admin/platforms/[id]/models — 批量校正所有模型的 type 字段
 * 用于修复历史数据中 type 默认为 "chat" 的问题
 */
export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const { id } = await params;

  const models = await prisma.platformModel.findMany({
    where: { platformId: id },
  });

  let updated = 0;
  for (const model of models) {
    const correctType = detectModelType(model.modelId);
    if (model.type !== correctType) {
      await prisma.platformModel.update({
        where: { id: model.id },
        data: { type: correctType },
      });
      updated++;
    }
  }

  return NextResponse.json({
    success: true,
    data: { total: models.length, updated },
    message: `校正完成，共 ${models.length} 个模型，修正 ${updated} 个`,
  });
}
