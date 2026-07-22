/**
 * GET /api/admin/usage/trend — 获取请求量和 Token 使用趋势
 *
 * 查询参数：
 * - period: 时间范围（today/week/month/all），默认 month
 * - keyId: 可选，指定单个 Key ID
 *
 * 聚合粒度：
 * - today: 按小时聚合（显示 24 小时趋势）
 * - week/month/all: 按天聚合
 *
 * 参考 main 分支：src/app/api/admin/usage/trend/route.ts
 * 迁移变更：MySQL DATE_FORMAT → SQLite strftime
 * 注意：createdAt 为 Unix 时间戳（秒），需先转为 datetime 再格式化
 */

import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/db";
import { requestLogs } from "@/lib/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { verifyToken } from "@/lib/auth";

export const runtime = "edge";

/**
 * 从请求中提取管理员身份
 */
async function getAdminFromRequest(request: NextRequest): Promise<{ adminId: string; username: string } | null> {
  try {
    const token = request.cookies.get("admin_token")?.value;
    if (!token) return null;
    const payload = await verifyToken(token);
    if (!payload || !payload.adminId || !payload.username) return null;
    return { adminId: payload.adminId as string, username: payload.username as string };
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const admin = await getAdminFromRequest(request);
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    const db = (globalThis as any).DB;
    if (!db) {
      return NextResponse.json({ success: false, error: "数据库未配置" }, { status: 500 });
    }
    const orm = createDb(db);

    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "month";
    const keyId = searchParams.get("keyId");

    // 计算时间范围（Unix 时间戳，秒）
    const now = Math.floor(Date.now() / 1000);
    let startTimestamp: number;
    switch (period) {
      case "today": {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        startTimestamp = Math.floor(d.getTime() / 1000);
        break;
      }
      case "week":
        startTimestamp = now - 7 * 24 * 60 * 60;
        break;
      case "month":
        startTimestamp = now - 30 * 24 * 60 * 60;
        break;
      default: {
        // all：取最早请求时间
        const earliest = await orm
          .select({ createdAt: requestLogs.createdAt })
          .from(requestLogs)
          .orderBy(requestLogs.createdAt)
          .limit(1);
        startTimestamp = earliest[0]?.createdAt || (now - 30 * 24 * 60 * 60);
      }
    }

    // 根据 period 决定聚合粒度：today 按小时，其他按天
    const isHourly = period === "today";

    // SQLite strftime 格式化：
    // createdAt 是 Unix 时间戳（秒），用 datetime(createdAt, 'unixepoch') 转为日期时间
    // 按小时：'%Y-%m-%d %H:00'
    // 按天：'%Y-%m-%d'
    const strftimeFormat = isHourly ? "%Y-%m-%d %H:00" : "%Y-%m-%d";

    // 构建查询条件
    const conditions = [
      gte(requestLogs.createdAt, startTimestamp),
      eq(requestLogs.isError, false),
    ];
    if (keyId) {
      conditions.push(eq(requestLogs.keyId, keyId));
    }
    const whereClause = and(...conditions);

    // 使用 Drizzle sql 模板进行 SQLite strftime 聚合
    const rows = await orm
      .select({
        date: sql<string>`strftime(${strftimeFormat}, datetime(${requestLogs.createdAt}, 'unixepoch'))`,
        requests: sql<number>`count(*)`,
        tokens: sql<number>`coalesce(sum(${requestLogs.tokens}), 0)`,
        promptTokens: sql<number>`coalesce(sum(${requestLogs.promptTokens}), 0)`,
        completionTokens: sql<number>`coalesce(sum(${requestLogs.completionTokens}), 0)`,
      })
      .from(requestLogs)
      .where(whereClause)
      .groupBy(sql`strftime(${strftimeFormat}, datetime(${requestLogs.createdAt}, 'unixepoch'))`)
      .orderBy(sql`date ASC`);

    const trend = rows.map((row) => ({
      date: String(row.date),
      requests: Number(row.requests),
      tokens: Number(row.tokens),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
    }));

    return NextResponse.json({ success: true, data: trend });
  } catch (err) {
    console.error("[GET /api/admin/usage/trend] 获取趋势数据失败:", err);
    return NextResponse.json(
      { success: false, error: "获取趋势数据失败" },
      { status: 500 }
    );
  }
}
