import { NextRequest, NextResponse } from "next/server";
import { getAdminFromRequest } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Config 表中的存储键
const CONFIG_KEY = "system:request_templates";

export interface RequestTemplate {
  id: string;
  name: string;
  description: string;
  endpoint: string; // "all" | "chat/completions" | "embeddings" | ...
  mergeBody: Record<string, unknown>;
  enabled: boolean;
}

// ==================== GET ====================

export async function GET() {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const config = await prisma.config.findUnique({ where: { key: CONFIG_KEY } });
  const templates: RequestTemplate[] = config?.value ? JSON.parse(config.value) : [];

  return NextResponse.json({ success: true, data: templates });
}

// ==================== POST ====================

export async function POST(request: NextRequest) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const body = await request.json();
  const { name, description, endpoint, mergeBody } = body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json(
      { success: false, error: "模板名称不能为空" },
      { status: 400 }
    );
  }

  if (!mergeBody || typeof mergeBody !== "object") {
    return NextResponse.json(
      { success: false, error: "请求体内容不能为空" },
      { status: 400 }
    );
  }

  // 读取现有模板
  const config = await prisma.config.findUnique({ where: { key: CONFIG_KEY } });
  const templates: RequestTemplate[] = config?.value ? JSON.parse(config.value) : [];

  const newTemplate: RequestTemplate = {
    id: crypto.randomUUID(),
    name: name.trim(),
    description: description?.trim() || "",
    endpoint: endpoint || "all",
    mergeBody,
    enabled: true,
  };

  templates.push(newTemplate);

  await prisma.config.upsert({
    where: { key: CONFIG_KEY },
    update: { value: JSON.stringify(templates) },
    create: { key: CONFIG_KEY, value: JSON.stringify(templates) },
  });

  return NextResponse.json({ success: true, data: newTemplate, message: "模板创建成功" });
}

// ==================== PUT ====================

export async function PUT(request: NextRequest) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const body = await request.json();
  const { id, name, description, endpoint, mergeBody, enabled } = body;

  if (!id) {
    return NextResponse.json(
      { success: false, error: "缺少模板 ID" },
      { status: 400 }
    );
  }

  // 读取现有模板
  const config = await prisma.config.findUnique({ where: { key: CONFIG_KEY } });
  const templates: RequestTemplate[] = config?.value ? JSON.parse(config.value) : [];

  const idx = templates.findIndex((t) => t.id === id);
  if (idx === -1) {
    return NextResponse.json(
      { success: false, error: "模板不存在" },
      { status: 404 }
    );
  }

  // 更新字段
  if (name !== undefined) templates[idx].name = name.trim();
  if (description !== undefined) templates[idx].description = description.trim();
  if (endpoint !== undefined) templates[idx].endpoint = endpoint;
  if (mergeBody !== undefined) templates[idx].mergeBody = mergeBody;
  if (enabled !== undefined) templates[idx].enabled = enabled;

  await prisma.config.upsert({
    where: { key: CONFIG_KEY },
    update: { value: JSON.stringify(templates) },
    create: { key: CONFIG_KEY, value: JSON.stringify(templates) },
  });

  return NextResponse.json({ success: true, data: templates[idx], message: "模板更新成功" });
}

// ==================== DELETE ====================

export async function DELETE(request: NextRequest) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json(
      { success: false, error: "缺少模板 ID" },
      { status: 400 }
    );
  }

  // 读取现有模板
  const config = await prisma.config.findUnique({ where: { key: CONFIG_KEY } });
  const templates: RequestTemplate[] = config?.value ? JSON.parse(config.value) : [];

  const idx = templates.findIndex((t) => t.id === id);
  if (idx === -1) {
    return NextResponse.json(
      { success: false, error: "模板不存在" },
      { status: 404 }
    );
  }

  templates.splice(idx, 1);

  await prisma.config.upsert({
    where: { key: CONFIG_KEY },
    update: { value: JSON.stringify(templates) },
    create: { key: CONFIG_KEY, value: JSON.stringify(templates) },
  });

  return NextResponse.json({ success: true, message: "模板已删除" });
}
