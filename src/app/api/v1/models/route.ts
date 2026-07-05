import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/v1/models — 模型列表聚合端点
 *
 * 自动访问每个已启用平台的上游 /v1/models 接口，
 * 聚合去重后返回 OpenAI 兼容格式的模型列表。
 */

interface UpstreamModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

const FETCH_TIMEOUT_MS = 10_000;

/** 从单个平台获取模型列表，失败返回空数组 */
async function fetchPlatformModels(platform: {
  id: string;
  baseUrl: string;
  apiKey: string;
  name: string;
}): Promise<UpstreamModel[]> {
  const url = `${platform.baseUrl.replace(/\/+$/, "")}/v1/models`;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${platform.apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return [];

    const data = await res.json();
    // 兼容 OpenAI 格式 { data: [...] } 和直接数组格式
    const list: unknown[] = Array.isArray(data) ? data : data?.data;
    if (!Array.isArray(list)) return [];

    return list
      .filter((item): item is UpstreamModel =>
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        typeof (item as Record<string, unknown>).id === "string"
      )
      .map((m) => ({
        id: m.id,
        object: m.object ?? "model",
        created: m.created ?? 0,
        owned_by: m.owned_by ?? platform.name,
      }));
  } catch {
    // 平台不可达或超时，跳过
    return [];
  }
}

export async function GET(request: NextRequest) {
  // ── 1. 验证 API Key ──
  const authHeader = request.headers.get("authorization");
  const apiKeyStr = authHeader?.replace("Bearer ", "");

  if (!apiKeyStr) {
    return Response.json(
      { error: { message: "缺少 API Key", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  const apiKey = await prisma.apiKey.findUnique({
    where: { key: apiKeyStr },
  });

  if (!apiKey || apiKey.status !== "active") {
    return Response.json(
      { error: { message: "无效的 API Key", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return Response.json(
      { error: { message: "API Key 已过期", type: "invalid_request_error" } },
      { status: 401 }
    );
  }

  // ── 2. 获取所有已启用平台 ──
  const platforms = await prisma.platform.findMany({
    where: { enabled: true },
    select: { id: true, name: true, baseUrl: true, apiKey: true },
  });

  if (platforms.length === 0) {
    return Response.json({ object: "list", data: [] });
  }

  // ── 3. 并发访问各平台 /v1/models ──
  const results = await Promise.allSettled(
    platforms.map((p) => fetchPlatformModels(p))
  );

  // ── 4. 聚合去重（按模型 ID 去重，保留首次出现的元信息） ──
  const seen = new Set<string>();
  const models: UpstreamModel[] = [];

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const m of result.value) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
    }
  }

  // 按模型 ID 排序，保证返回顺序稳定
  models.sort((a, b) => a.id.localeCompare(b.id));

  return Response.json({
    object: "list",
    data: models,
  });
}
