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
import { createDb } from "@/lib/db";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
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
      const conditions: string[] = [];

      // 错误筛选
      if (isError === "true") {
        conditions.push("level IN ('error', 'critical')");
      } else if (isError === "false") {
        conditions.push("level IN ('info', 'warning')");
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const [items, countResult] = await Promise.all([
        (db as any).all(
          `SELECT id, level, message, detail, created_at
           FROM system_events
           ${whereClause}
           ORDER BY created_at DESC
           LIMIT ${pageSize} OFFSET ${offset}`
        ) as Promise<Array<{ id: string; level: string; message: string; detail: string | null; created_at: number }>>,
        (db as any).get(
          `SELECT COUNT(*) as count FROM system_events ${whereClause}`
        ) as Promise<{ count: number } | null>,
      ]);

      const total = countResult?.count ?? 0;

      res.status(200).json({
        success: true,
        data: {
          items: items.map((e) => ({
            id: e.id,
            level: e.level,
            message: e.message,
            detail: e.detail,
            createdAt: new Date(e.created_at * 1000).toISOString(),
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
    interface RequestLogRow {
      id: string;
      key_id: string | null;
      key_name: string | null;
      platform_id: string | null;
      model: string;
      endpoint: string | null;
      method: string | null;
      status: number;
      latency: number;
      tokens: number;
      prompt_tokens: number;
      completion_tokens: number;
      cost: number;
      is_error: number;
      ip_address: string | null;
      user_agent: string | null;
      error_message: string | null;
      created_at: number;
    }
    const conditions: string[] = [];
    const params: any[] = [];

    // 状态码筛选
    if (status) {
      const n = parseInt(status, 10);
      if (!isNaN(n)) {
        conditions.push("status = ?");
        params.push(n);
      }
    }

    // 错误筛选（is_error 为 INTEGER 0/1）
    if (isError === "true") {
      conditions.push("is_error = 1");
    } else if (isError === "false") {
      conditions.push("is_error = 0");
    }

    // API Key 筛选
    if (keyId) {
      conditions.push("key_id = ?");
      params.push(keyId);
    }

    // 日期范围筛选（SQLite 存储 Unix 时间戳）
    if (startDateStr) {
      const startTs = Math.floor(new Date(startDateStr).getTime() / 1000);
      conditions.push("created_at >= ?");
      params.push(startTs);
    }
    if (endDateStr) {
      // 结束日期含当天全部：取当天 23:59:59
      const end = new Date(endDateStr);
      end.setHours(23, 59, 59, 999);
      const endTs = Math.floor(end.getTime() / 1000);
      conditions.push("created_at <= ?");
      params.push(endTs);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // 构建带参数的 SQL
    const countSql = `SELECT COUNT(*) as count FROM request_logs ${whereClause}`;
    const itemsSql = `SELECT * FROM request_logs ${whereClause} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;

    const [items, countResult] = await Promise.all([
      (db as any).all(itemsSql, ...params) as Promise<RequestLogRow[]>,
      (db as any).get(countSql, ...params) as Promise<{ count: number } | null>,
    ]);

    const total = countResult?.count ?? 0;

    res.status(200).json({
      success: true,
      data: {
        items: items.map((log) => ({
          ...log,
          createdAt: new Date(log.created_at * 1000).toISOString(),
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
