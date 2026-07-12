import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";

/**
 * 导出数据类型
 * - system: 系统级导出（配置、平台、密钥等）
 * - data: 普通数据导出（日志、统计等）
 * - all: 全部导出
 */
type ExportType = "system" | "data" | "all";

/**
 * GET /api/admin/export — 导出系统数据
 *
 * 查询参数：
 * - type: 导出类型（system/data/all），默认 all
 * - format: 导出格式（json/zip），默认 json
 *
 * 导出内容：
 * - system: 平台、API Keys、模型映射、代理、代理池、配置、套餐
 * - data: API Keys、请求日志、每日统计、审计日志、系统事件
 * - all: 以上全部
 */
export async function GET(request: NextRequest) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json(
      { success: false, error: "未授权" },
      { status: 401 }
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const exportType = (searchParams.get("type") || "all") as ExportType;

    const exportData: Record<string, unknown> = {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      exportType,
      adminId: admin.adminId,
    };

    // 系统级导出
    if (exportType === "system" || exportType === "all") {
      // 平台配置（脱敏 apiKey）
      const platforms = await prisma.platform.findMany({
        select: {
          id: true,
          name: true,
          baseUrl: true,
          apiKey: true,
          apiKeys: true,
          type: true,
          enabled: true,
          priority: true,
          weight: true,
          rpmLimit: true,
          tpmLimit: true,
          forwardHeaders: true,
          status: true,
        },
      });

      exportData.platforms = platforms;

      // 模型映射
      exportData.modelMaps = await prisma.modelMap.findMany({
        select: {
          alias: true,
          targetModel: true,
          platformId: true,
        },
      });

      // 代理
      const proxies = await prisma.proxy.findMany({
        select: {
          id: true,
          address: true,
          poolId: true,
          enabled: true,
          status: true,
        },
      });

      exportData.proxies = proxies;

      // 代理池
      exportData.proxyPools = await prisma.proxyPool.findMany({
        select: {
          id: true,
          name: true,
          enabled: true,
        },
      });

      // 套餐模板
      exportData.plans = await prisma.plan.findMany({
        select: {
          name: true,
          tokenQuota: true,
          callLimit: true,
          rpmLimit: true,
          tpmLimit: true,
          resetPeriod: true,
        },
      });

      // 系统配置（全部导出）
      const configs = await prisma.config.findMany({
        select: {
          key: true,
          value: true,
        },
      });

      exportData.configs = configs;
    }

    // 普通数据导出
    if (exportType === "data" || exportType === "all") {
      // API Keys（脱敏）
      const apiKeys = await prisma.apiKey.findMany({
        select: {
          id: true,
          name: true,
          key: true,
          planId: true,
          quota: true,
          usedTokens: true,
          rpmLimit: true,
          tpmLimit: true,
          callLimit: true,
          tokenLimit: true,
          resetPeriod: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      });

      exportData.apiKeys = apiKeys;

      // 请求日志（最近 30 天）
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      exportData.requestLogs = await prisma.requestLog.findMany({
        where: {
          createdAt: { gte: thirtyDaysAgo },
        },
        select: {
          keyId: true,
          platformId: true,
          model: true,
          status: true,
          tokens: true,
          promptTokens: true,
          completionTokens: true,
          ttft: true,
          duration: true,
          isError: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 10000, // 限制数量
      });

      // 每日统计
      exportData.dailyStats = await prisma.dailyStats.findMany({
        select: {
          date: true,
          keyId: true,
          keyName: true,
          platformId: true,
          platformName: true,
          model: true,
          totalRequests: true,
          errorRequests: true,
          totalTokens: true,
          totalPromptTokens: true,
          totalCompletionTokens: true,
          avgTtft: true,
          avgDuration: true,
          maxTtft: true,
          maxDuration: true,
        },
        orderBy: { date: "desc" },
        take: 1000, // 限制数量
      });

      // 审计日志（最近 30 天）
      exportData.auditLogs = await prisma.auditLog.findMany({
        where: {
          createdAt: { gte: thirtyDaysAgo },
        },
        select: {
          adminId: true,
          action: true,
          detail: true,
          ip: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 5000,
      });

      // 系统事件（最近 30 天）
      exportData.systemEvents = await prisma.systemEvent.findMany({
        where: {
          createdAt: { gte: thirtyDaysAgo },
        },
        select: {
          level: true,
          message: true,
          detail: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 2000,
      });
    }

    // 记录审计日志
    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "export_data",
        detail: JSON.stringify({ exportType }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    // 返回 JSON 文件下载
    const filename = `fwp-export-${exportType}-${new Date().toISOString().slice(0, 10)}.json`;
    const jsonContent = JSON.stringify(exportData, null, 2);

    return new NextResponse(jsonContent, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/export] 导出数据失败:", err);
    return NextResponse.json(
      { success: false, error: "导出数据失败" },
      { status: 500 }
    );
  }
}
