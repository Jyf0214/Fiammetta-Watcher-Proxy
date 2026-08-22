/**
 * GET /api/admin/logs — 获取请求日志列表
 *
 * 查询参数：
 * - page: 页码，默认 1
 * - pageSize: 每页条数，默认 20，最大 100
 * - status: HTTP 状态码筛选
 * - isError: 是否错误（true/false）
 * - keyId: 按 API Key 筛选
 * - startDate: 起始日期（ISO 格式或 YYYY-MM-DD）
 * - endDate: 结束日期（ISO 格式或 YYYY-MM-DD，含当天全部）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { createDb, type Prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    res.status(401).json({ success: false, error: "未授权" });
    return;
  }
  // 速率限制：防止 JWT 泄露后高频轮询枚举
  if (!await checkAdminRateLimit(admin.adminId, res)) return;

  try {
    const db = await createDb();

    const page = Math.max(1, parseInt((req.query.page as string) || "1", 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt((req.query.pageSize as string) || "20", 10) || 20)
    );
    const status = req.query.status as string | undefined;
    const isError = req.query.isError as string | undefined;
    const keyId = req.query.keyId as string | undefined;
    const startDateStr = req.query.startDate as string | undefined;
    const endDateStr = req.query.endDate as string | undefined;

    const offset = (page - 1) * pageSize;

    // ---------- 请求日志查询 ----------
    const where: Prisma.requestLogsWhereInput = {};

    if (status) {
      const n = parseInt(status, 10);
      if (isNaN(n)) {
        return res.status(400).json({ success: false, error: "无效的 status，必须为整数" });
      }
      // createdAt 为 Int（Int32）：status 同为 Int 列，超界值会触发 Prisma Int
      // 校验失败 → 500，这里与日期参数相同的显式范围校验
      if (n < 0 || n > 2147483647) {
        return res.status(400).json({ success: false, error: "status 超出支持范围" });
      }
      where.status = n;
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
    // 先校验可解析性：非法字符串 new Date().getTime() 为 NaN，落入 Prisma Int
    // 过滤器会触发校验失败返回 500，这里显式 400
    // 时区口径统一为显式 UTC：YYYY-MM-DD 拼接 T00:00:00Z / T23:59:59.999Z 解析
    // （此前 endDate 用 setHours(23,59,59,999) 走服务器本地时区，非 UTC 服务器
    // 当天 16:00 后的日志会被排除），与 logs/archive.ts 的显式 UTC 写法一致；
    // 完整 ISO 时间字符串（含 T）直接解析，保持原有 ISO 格式支持
    if (startDateStr || endDateStr) {
      const createdAt: Prisma.IntFilter = {};
      if (startDateStr) {
        const ts = new Date(
          startDateStr.includes("T") ? startDateStr : startDateStr + "T00:00:00Z"
        ).getTime();
        if (isNaN(ts)) {
          return res.status(400).json({ success: false, error: "无效的 startDate，请使用 YYYY-MM-DD 或 ISO 格式" });
        }
        const sec = Math.floor(ts / 1000);
        // createdAt 为 Int（Int32）：超出可表示范围会触发 Prisma Int 校验失败 → 500
        if (sec < 0 || sec > 2147483647) {
          return res.status(400).json({ success: false, error: "startDate 超出支持范围" });
        }
        createdAt.gte = sec;
      }
      if (endDateStr) {
        const end = new Date(
          endDateStr.includes("T") ? endDateStr : endDateStr + "T23:59:59.999Z"
        );
        if (isNaN(end.getTime())) {
          return res.status(400).json({ success: false, error: "无效的 endDate，请使用 YYYY-MM-DD 或 ISO 格式" });
        }
        const sec = Math.floor(end.getTime() / 1000);
        if (sec < 0 || sec > 2147483647) {
          return res.status(400).json({ success: false, error: "endDate 超出支持范围" });
        }
        createdAt.lte = sec;
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
          nodeName: log.nodeName,
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
    res.status(500).json({ success: false, error: "获取日志失败" });
  }
}
