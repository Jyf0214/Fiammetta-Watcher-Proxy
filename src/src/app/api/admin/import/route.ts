import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { forceRefreshRouterCache } from "@/lib/router";

/**
 * 导入结果
 */
interface ImportResult {
  success: boolean;
  message: string;
  details: {
    platforms?: { imported: number; skipped: number };
    modelMaps?: { imported: number; skipped: number };
    proxies?: { imported: number; skipped: number };
    proxyPools?: { imported: number; skipped: number };
    plans?: { imported: number; skipped: number };
    apiKeys?: { imported: number; skipped: number };
    configs?: { imported: number; skipped: number };
  };
}

/**
 * POST /api/admin/import — 导入数据
 *
 * 请求体：导出的 JSON 数据
 *
 * 导入规则：
 * - 系统级数据：按 ID 或名称匹配，已存在则跳过
 * - 敏感数据（apiKey、key等）：需要提供原始值，脱敏的值会被跳过
 * - 导入不会删除现有数据，只添加新数据
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

    // 验证导入数据格式
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { success: false, error: "无效的导入数据格式" },
        { status: 400 }
      );
    }

    if (!body.version || !body.exportedAt) {
      return NextResponse.json(
        { success: false, error: "缺少必要的导出元数据（version、exportedAt）" },
        { status: 400 }
      );
    }

    const result: ImportResult = {
      success: true,
      message: "导入完成",
      details: {},
    };

    // 导入平台配置
    if (body.platforms && Array.isArray(body.platforms)) {
      result.details.platforms = await importPlatforms(body.platforms);
    }

    // 导入模型映射
    if (body.modelMaps && Array.isArray(body.modelMaps)) {
      result.details.modelMaps = await importModelMaps(body.modelMaps);
    }

    // 导入代理池
    if (body.proxyPools && Array.isArray(body.proxyPools)) {
      result.details.proxyPools = await importProxyPools(body.proxyPools);
    }

    // 导入代理
    if (body.proxies && Array.isArray(body.proxies)) {
      result.details.proxies = await importProxies(body.proxies);
    }

    // 导入套餐模板
    if (body.plans && Array.isArray(body.plans)) {
      result.details.plans = await importPlans(body.plans);
    }

    // 导入 API Keys
    if (body.apiKeys && Array.isArray(body.apiKeys)) {
      result.details.apiKeys = await importApiKeys(body.apiKeys);
    }

    // 导入系统配置
    if (body.configs && Array.isArray(body.configs)) {
      result.details.configs = await importConfigs(body.configs);
    }

    // 刷新路由缓存
    await forceRefreshRouterCache();

    // 记录审计日志
    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "import_data",
        detail: JSON.stringify({
          exportType: body.exportType,
          exportedAt: body.exportedAt,
          details: result.details,
        }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    // 汇总导入结果
    const summary = Object.entries(result.details)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v.imported} 导入, ${v.skipped} 跳过`)
      .join(", ");

    result.message = summary ? `导入完成: ${summary}` : "没有需要导入的数据";

    return NextResponse.json(result);
  } catch (err) {
    console.error("[POST /api/admin/import] 导入数据失败:", err);
    return NextResponse.json(
      { success: false, error: "导入数据失败: " + (err instanceof Error ? err.message : String(err)) },
      { status: 500 }
    );
  }
}

/**
 * 导入平台配置
 */
async function importPlatforms(
  platforms: Array<Record<string, unknown>>
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const p of platforms) {
    try {
      // 检查是否已存在（按名称）
      const existing = await prisma.platform.findFirst({
        where: { name: p.name as string },
      });

      if (existing) {
        skipped++;
        continue;
      }

      // 检查 apiKey 是否为脱敏值
      const apiKey = p.apiKey as string;
      if (!apiKey || apiKey.includes("***")) {
        skipped++;
        continue;
      }

      await prisma.platform.create({
        data: {
          name: p.name as string,
          baseUrl: p.baseUrl as string,
          apiKey: apiKey,
          apiKeys: (p.apiKeys as string) || "[]",
          type: (p.type as string) || "openai",
          enabled: (p.enabled as boolean) ?? true,
          priority: (p.priority as number) ?? 0,
          weight: (p.weight as number) ?? 1,
          rpmLimit: (p.rpmLimit as number) ?? null,
          tpmLimit: (p.tpmLimit as number) ?? null,
          forwardHeaders: (p.forwardHeaders as string) || "[]",
          status: "healthy",
        },
      });

      imported++;
    } catch (err) {
      console.error("[import] 导入平台失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 导入模型映射
 */
async function importModelMaps(
  modelMaps: Array<Record<string, unknown>>
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const m of modelMaps) {
    try {
      // 检查是否已存在
      const existing = await prisma.modelMap.findFirst({
        where: {
          alias: m.alias as string,
          platformId: (m.platformId as string) || null,
        },
      });

      if (existing) {
        skipped++;
        continue;
      }

      await prisma.modelMap.create({
        data: {
          alias: m.alias as string,
          targetModel: m.targetModel as string,
          platformId: (m.platformId as string) || null,
        },
      });

      imported++;
    } catch (err) {
      console.error("[import] 导入模型映射失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 导入代理池
 */
async function importProxyPools(
  pools: Array<Record<string, unknown>>
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const p of pools) {
    try {
      // 检查是否已存在（按名称）
      const existing = await prisma.proxyPool.findFirst({
        where: { name: p.name as string },
      });

      if (existing) {
        skipped++;
        continue;
      }

      await prisma.proxyPool.create({
        data: {
          name: p.name as string,
          enabled: (p.enabled as boolean) ?? true,
        },
      });

      imported++;
    } catch (err) {
      console.error("[import] 导入代理池失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 导入代理
 */
async function importProxies(
  proxies: Array<Record<string, unknown>>
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const p of proxies) {
    try {
      // 检查是否已存在（按地址）
      const address = p.address as string;
      if (!address || address.includes("***")) {
        skipped++;
        continue;
      }

      const existing = await prisma.proxy.findFirst({
        where: { address },
      });

      if (existing) {
        skipped++;
        continue;
      }

      await prisma.proxy.create({
        data: {
          address,
          poolId: (p.poolId as string) || null,
          enabled: (p.enabled as boolean) ?? true,
          status: "healthy",
        },
      });

      imported++;
    } catch (err) {
      console.error("[import] 导入代理失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 导入套餐模板
 */
async function importPlans(
  plans: Array<Record<string, unknown>>
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const p of plans) {
    try {
      // 检查是否已存在（按名称）
      const existing = await prisma.plan.findFirst({
        where: { name: p.name as string },
      });

      if (existing) {
        skipped++;
        continue;
      }

      await prisma.plan.create({
        data: {
          name: p.name as string,
          tokenQuota: BigInt(p.tokenQuota as number),
          callLimit: p.callLimit as number,
          rpmLimit: p.rpmLimit as number,
          tpmLimit: p.tpmLimit as number,
          resetPeriod: (p.resetPeriod as string) || "monthly",
        },
      });

      imported++;
    } catch (err) {
      console.error("[import] 导入套餐失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 导入 API Keys
 */
async function importApiKeys(
  apiKeys: Array<Record<string, unknown>>
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const k of apiKeys) {
    try {
      // 检查 key 是否为脱敏值
      const key = k.key as string;
      if (!key || key.includes("***")) {
        skipped++;
        continue;
      }

      // 检查是否已存在
      const existing = await prisma.apiKey.findUnique({
        where: { key },
      });

      if (existing) {
        skipped++;
        continue;
      }

      await prisma.apiKey.create({
        data: {
          key,
          name: (k.name as string) || "导入的 Key",
          planId: (k.planId as string) || null,
          quota: k.quota ? Number(k.quota) : null,
          usedTokens: BigInt(k.usedTokens as number || 0),
          rpmLimit: (k.rpmLimit as number) ?? null,
          tpmLimit: (k.tpmLimit as number) ?? null,
          callLimit: (k.callLimit as number) ?? null,
          tokenLimit: k.tokenLimit ? BigInt(k.tokenLimit as number) : null,
          resetPeriod: (k.resetPeriod as string) || "monthly",
          status: (k.status as string) || "active",
          expiresAt: k.expiresAt ? new Date(k.expiresAt as string) : null,
        },
      });

      imported++;
    } catch (err) {
      console.error("[import] 导入 API Key 失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}

/**
 * 导入系统配置
 */
async function importConfigs(
  configs: Array<Record<string, unknown>>
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  for (const c of configs) {
    try {
      const key = c.key as string;
      const value = c.value as string;

      if (!key || !value) {
        skipped++;
        continue;
      }

      // 跳过敏感配置
      if (key === "admin_reset_password") {
        skipped++;
        continue;
      }

      // 更新或创建配置
      await prisma.config.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });

      imported++;
    } catch (err) {
      console.error("[import] 导入配置失败:", err);
      skipped++;
    }
  }

  return { imported, skipped };
}
