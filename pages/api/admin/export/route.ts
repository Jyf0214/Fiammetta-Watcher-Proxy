/**
 * 数据导出 API
 *
 * GET /api/admin/export — 导出系统数据
 *
 * 查询参数：
 * - type: 导出类型（system/data/all），默认 all
 *   - system: 平台、模型映射、代理、代理池、配置、套餐
 *   - data: API Keys、请求日志、每日统计、审计日志、系统事件
 *   - all: 以上全部
 *
 * 返回 JSON 文件下载，Content-Type: application/json
 */

export const runtime = "edge";

import { NextRequest } from "next/server";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";
import { desc } from "drizzle-orm";

/** 导出类型 */
type ExportType = "system" | "data" | "all";

/**
 * GET /api/admin/export — 导出系统数据
 *
 * 认证由中间件处理（Cookie JWT），无需在此验证。
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const exportType = (searchParams.get("type") || "all") as ExportType;

    // 中间件已注入 db 到 context.data，但 App Router 的 GET 签名
    // 只有 (request, context) 两个参数。此处从 request headers
    // 无法获取 context.data，改用 globalThis.DB（中间件已设置）。
    const db = createDb((globalThis as Record<string, unknown>).DB as D1Database);

    const now = Math.floor(Date.now() / 1000);

    // 导出数据基础结构
    const exportData: Record<string, unknown> = {
      version: "1.0.0",
      exportedAt: new Date(now * 1000).toISOString(),
      exportType,
    };

    // ==================== 系统级导出 ====================
    if (exportType === "system" || exportType === "all") {
      // 平台配置（保留 apiKey 明文，用于跨环境迁移）
      const platforms = await db
        .select()
        .from(schema.platforms);

      exportData.platforms = platforms.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        apiKeys: p.apiKeys,
        type: p.type,
        enabled: p.enabled,
        priority: p.priority,
        weight: p.weight,
        rpmLimit: p.rpmLimit,
        tpmLimit: p.tpmLimit,
        forwardHeaders: p.forwardHeaders,
        status: p.status,
      }));

      // 模型映射
      const modelMaps = await db
        .select()
        .from(schema.modelMappings);

      exportData.modelMaps = modelMaps.map((m) => ({
        alias: m.alias,
        targetModel: m.targetModel,
        platformId: m.platformId,
      }));

      // 代理
      const proxies = await db
        .select()
        .from(schema.proxies);

      exportData.proxies = proxies.map((p) => ({
        id: p.id,
        address: p.address,
        poolId: p.poolId,
        enabled: p.enabled,
        status: p.status,
      }));

      // 代理池
      const proxyPools = await db
        .select()
        .from(schema.proxyPools);

      exportData.proxyPools = proxyPools.map((p) => ({
        id: p.id,
        name: p.name,
        enabled: p.enabled,
      }));

      // 套餐模板
      const plans = await db
        .select()
        .from(schema.plans);

      exportData.plans = plans.map((p) => ({
        name: p.name,
        tokenQuota: p.tokenQuota,
        callLimit: p.callLimit,
        rpmLimit: p.rpmLimit,
        tpmLimit: p.tpmLimit,
        resetPeriod: p.resetPeriod,
      }));

      // 系统配置（全部导出）
      const configs = await db
        .select()
        .from(schema.configs);

      exportData.configs = configs.map((c) => ({
        key: c.key,
        value: c.value,
      }));
    }

    // ==================== 数据级导出 ====================
    if (exportType === "data" || exportType === "all") {
      // API Keys（保留明文，用于跨环境迁移）
      const apiKeys = await db
        .select()
        .from(schema.apiKeys);

      exportData.apiKeys = apiKeys.map((k) => ({
        id: k.id,
        key: k.key,
        name: k.name,
        planId: k.planId,
        quota: k.quota,
        usedTokens: k.usedTokens,
        rpmLimit: k.rpmLimit,
        tpmLimit: k.tpmLimit,
        callLimit: k.callLimit,
        callUsed: k.callUsed,
        tokenLimit: k.tokenLimit,
        resetPeriod: k.resetPeriod,
        status: k.status,
        expiresAt: k.expiresAt,
        createdAt: k.createdAt,
      }));

      // 请求日志（最近 30 天，最多 10000 条）
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60;
      const requestLogs = await db
        .select()
        .from(schema.requestLogs)
        .orderBy(desc(schema.requestLogs.createdAt))
        .limit(10000);

      exportData.requestLogs = requestLogs
        .filter((r) => r.createdAt >= thirtyDaysAgo)
        .map((r) => ({
          keyId: r.keyId,
          keyName: r.keyName,
          platformId: r.platformId,
          model: r.model,
          endpoint: r.endpoint,
          method: r.method,
          status: r.status,
          latency: r.latency,
          tokens: r.tokens,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          ttft: r.ttft,
          cost: r.cost,
          isError: r.isError,
          ipAddress: r.ipAddress,
          errorMessage: r.errorMessage,
          createdAt: r.createdAt,
        }));

      // 每日统计（最近 1000 条）
      const dailyStats = await db
        .select()
        .from(schema.dailyStats)
        .orderBy(desc(schema.dailyStats.date))
        .limit(1000);

      exportData.dailyStats = dailyStats;

      // 审计日志（最近 30 天，最多 5000 条）
      const auditLogs = await db
        .select()
        .from(schema.auditLogs)
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(5000);

      exportData.auditLogs = auditLogs
        .filter((l) => l.createdAt >= thirtyDaysAgo)
        .map((l) => ({
          adminId: l.adminId,
          action: l.action,
          detail: l.detail,
          ip: l.ip,
          createdAt: l.createdAt,
        }));

      // 系统事件（最近 30 天，最多 2000 条）
      const systemEvents = await db
        .select()
        .from(schema.systemEvents)
        .orderBy(desc(schema.systemEvents.createdAt))
        .limit(2000);

      exportData.systemEvents = systemEvents
        .filter((e) => e.createdAt >= thirtyDaysAgo)
        .map((e) => ({
          level: e.level,
          message: e.message,
          detail: e.detail,
          createdAt: e.createdAt,
        }));
    }

    // 审计日志：记录导出操作
    await db.insert(schema.auditLogs).values({
      id: crypto.randomUUID(),
      adminId: "export",
      action: "export_data",
      detail: JSON.stringify({ exportType }),
      ip:
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      createdAt: now,
    } as any);

    // 返回 JSON 文件下载
    const filename = `fwp-export-${exportType}-${new Date(now * 1000).toISOString().slice(0, 10)}.json`;
    const jsonContent = JSON.stringify(exportData, null, 2);

    return new Response(jsonContent, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/export] 导出数据失败:", err);
    return Response.json(
      { success: false, error: "导出数据失败" },
      { status: 500 }
    );
  }
}
