/**
 * 密码重置 API
 *
 * POST /api/admin/auth/reset-password — 请求重置管理员密码
 *
 * 写入数据库标志 admin_reset_password = "pending"
 * 下次管理员登录时读取此标志，使用 ADMIN_PASSWORD 环境变量强制更新密码
 *
 * 安全约束（无需登录即可访问）：
 * - IP 级别速率限制：24 小时内最多 3 次
 * - 仅当数据库中恰好有 1 个管理员时允许操作
 * - 环境变量 ADMIN_USERNAME 必须与现有管理员匹配
 *
 * 主分支对应文件：src/app/api/admin/auth/reset-password/route.ts
 * Pages Router 格式转换
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { eq, count } from "drizzle-orm";
import { createDb } from "@/lib/db";
import * as schema from "@/lib/schema";

const resetAttempts = new Map<string, { count: number; resetAt: number }>();
const RESET_RATE_LIMIT = 3;
const RESET_RATE_WINDOW = 24 * 60 * 60 * 1000;

function cleanupResetAttempts() {
  const now = Date.now();
  for (const [key, entry] of resetAttempts.entries()) {
    if (now > entry.resetAt) {
      resetAttempts.delete(key);
    }
  }
}

function checkResetRateLimit(ip: string): boolean {
  const now = Date.now();
  cleanupResetAttempts();
  const entry = resetAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    resetAttempts.set(ip, { count: 1, resetAt: now + RESET_RATE_WINDOW });
    return true;
  }
  if (entry.count >= RESET_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

function getClientIp(req: NextApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const str = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return str?.split(",")[0]?.trim() || (req.headers["x-real-ip"] as string) || "unknown";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  const env = {
    DB: (process.env as unknown as { DB: D1Database }).DB,
    ADMIN_USERNAME: process.env.ADMIN_USERNAME,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  };

  const clientIp = getClientIp(req);
  if (!checkResetRateLimit(clientIp)) {
    return res.status(429).json({ success: false, error: "密码重置请求过于频繁，请 24 小时后再试" });
  }

  if (!env.DB) {
    return res.status(500).json({ success: false, error: "数据库未配置" });
  }

  try {
    const db = createDb(env.DB);
    const [adminCountResult] = await db.select({ total: count() }).from(schema.admins);
    const adminCount = adminCountResult?.total ?? 0;

    if (adminCount === 0) {
      return res.status(400).json({ success: false, error: "数据库中无管理员账户，请通过 ADMIN_USERNAME / ADMIN_PASSWORD 环境变量创建" });
    }
    if (adminCount > 1) {
      return res.status(400).json({ success: false, error: `数据库中存在 ${adminCount} 个管理员账户，无法自动重置密码。请将所有管理员统一为一个，或手动修改数据库` });
    }

    const envUsername = env.ADMIN_USERNAME;
    const envPassword = env.ADMIN_PASSWORD;
    if (!envUsername || !envPassword) {
      return res.status(400).json({ success: false, error: "未配置 ADMIN_USERNAME 或 ADMIN_PASSWORD 环境变量，无法重置密码" });
    }

    const [admin] = await db.select().from(schema.admins).limit(1);
    if (admin && admin.username !== envUsername) {
      return res.status(400).json({ success: false, error: "管理员用户名与环境变量配置不匹配，请修改 ADMIN_USERNAME 环境变量使其与数据库中现有管理员一致后重试" });
    }

    const now = Math.floor(Date.now() / 1000);
    const [existingFlag] = await db.select().from(schema.configs).where(eq(schema.configs.key, "admin_reset_password")).limit(1);

    if (existingFlag) {
      await db.update(schema.configs).set({ value: "pending", updatedAt: now } as any).where(eq(schema.configs.key, "admin_reset_password"));
    } else {
      await db.insert(schema.configs).values({ key: "admin_reset_password", value: "pending", updatedAt: now } as any);
    }

    try {
      await db.insert(schema.systemEvents).values({
        id: crypto.randomUUID(),
        level: "info",
        message: "密码重置请求已提交",
        detail: JSON.stringify({ adminUsername: admin?.username, timestamp: new Date().toISOString() }),
        createdAt: now,
      } as any);
    } catch { /* 系统事件写入失败不阻塞主流程 */ }

    return res.status(200).json({ success: true, message: "密码重置标志已写入，服务将在下次登录时自动更新密码" });
  } catch (error) {
    console.error("密码重置请求处理异常:", error instanceof Error ? error.message : String(error));
    return res.status(500).json({ success: false, error: "提交密码重置请求失败" });
  }
}
