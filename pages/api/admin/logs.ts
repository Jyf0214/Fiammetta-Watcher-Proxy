/**
 * GET /api/admin/logs — 获取请求日志列表
 *
 * 查询参数：
 * - page: 页码，默认 1
 * - pageSize: 每页条数，默认 20，最大 100
 * - status: HTTP 状态码筛选
 * - isError: 是否错误（true/false）
 * - type: events — 查询系统事件
 * - keyId: 按 API Key 筛选
 * - startDate: 起始日期（ISO 格式或 YYYY-MM-DD）
 * - endDate: 结束日期（ISO 格式或 YYYY-MM-DD，含当天全部）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb } from "@/lib/prisma";
import { getAdminFromRequest } from "./_auth";
import type { Prisma } from "@/generated/client";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }

  try {
    const db = await createDb();

    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt((req.query.pageSize as string) || "20", 10) || 20)
    );
    const status = req.query.status as string | undefined;
    const isError = req.query.isError as string | undefined;
    const type = req.query.type as string | undefined;
    const keyId = req.query.keyId as string | undefined;
    const startDateStr = req.query.startDate as string | undefined;
    const endDateStr = req.query.endDate as string | undefined;

    const offset = (page - 1) * pageSize;

    // ---------- 系统事件查询 ----------
    if (type === "events") {
      const where: Prisma.systemEventsWhereInput = {};

      if (isError === "true") {
        where.level = { in: ["error", "critical"] };
      } else if (isError === "false") {
        where.level = { in: ["info", "warning"] };
      }

      const [items, total] = await Promise.all([
        db.systemEvents.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: pageSize,
          skip: offset,
          select: {
            id: true,
            level: true,
            message: true,
            detail: true,
            createdAt: true,
          },
        }),
        db.systemEvents.count({ where }),
      ]);

      res.status(200).json({
        success: true,
        data: {
          items: items.map((e) => ({
            id: e.id,
            level: e.level,
            message: e.message,
            detail: e.detail,
            createdAt: new Date(e.createdAt * 1000).toISOString(),
          })),
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
        },
      });
      return;
    }

    // ---------- 请求日志查询 ----------
    const where: Prisma.requestLogsWhereInput = {};

    if (status) {
      const n = parseInt(status, 10);
      if (!isNaN(n)) {
        where.status = n;
      }
    }

    if (isError === "true") {
      where.isError = true;
    } else if (isError === "false") {
      where.isError = false;
    }

    if (keyId) {
      where.keyId = keyId;
    }

    // 日期范围筛选（Unix 时间戳）
    if (startDateStr || endDateStr) {
      const createdAt: Prisma.IntFilter = {};
      if (startDateStr) {
        createdAt.gte = Math.floor(new Date(startDateStr).getTime() / 1000);
      }
      if (endDateStr) {
        const end = new Date(endDateStr);
        end.setHours(23, 59, 59, 999);
        createdAt.lte = Math.floor(end.getTime() / 1000);
      }
      where.createdAt = createdAt;
    }

    const [items, total] = await Promise.all([
      db.requestLogs.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: pageSize,
        skip: offset,
      }),
      db.requestLogs.count({ where }),
    ]);

    // 批量查询关联平台名称（Prisma 无 relation，手动 JOIN）
    const platformIds = [...new Set(items.map((r) => r.platformId).filter(Boolean))] as string[];
    let platformMap = new Map<string, string>();
    if (platformIds.length > 0) {
      const platforms = await db.platforms.findMany({
        where: { id: { in: platformIds } },
        select: { id: true, name: true },
      });
      platformMap = new Map(platforms.map((p) => [p.id, p.name]));
    }

    res.status(200).json({
      success: true,
      data: {
        items: items.map((log) => ({
          id: log.id,
          model: log.model,
          status: log.status,
          tokens: log.tokens,
          promptTokens: log.promptTokens,
          completionTokens: log.completionTokens,
          ttft: log.ttft ?? 0,
          duration: log.latency,
          isError: Boolean(log.isError),
          errorMessage: log.errorMessage,
          ipAddress: log.ipAddress,
          userAgent: log.userAgent,
          endpoint: log.endpoint,
          method: log.method,
          keyId: log.keyId,
          keyName: log.keyName,
          key: log.keyName ? { name: log.keyName } : null,
          platformId: log.platformId,
          platformName: log.platformId ? platformMap.get(log.platformId) ?? null : null,
          platform: log.platformId
            ? { name: platformMap.get(log.platformId) ?? null }
            : null,
          cost: log.cost,
          createdAt: new Date(log.createdAt * 1000).toISOString(),
        })),
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    console.error("[GET /api/admin/logs] 获取日志失败:", err);
    res.status(500).json({ success: false, error: "获取日志失败", detail: err instanceof Error ? err.message : String(err) });
  }
}
