/**
 * 定时任务路由 — 通用 HTTP 端点
 *
 * 通过外部服务（如 Cron-job.org、UptimeRobot 等）定时调用：
 *   GET/POST /api/cron/model-fetch  → 拉取平台模型
 *   GET/POST /api/cron/key-reset    → 重置 Key 用量
 *   GET/POST /api/cron/log-archive  → 归档过期日志
 *   GET/POST /api/cron/proxy-health → 出站代理健康检查（仅 Docker 部署有代理配置时生效）
 *
 * 认证：必须配置 CRON_SECRET 环境变量并携带 Authorization: Bearer <CRON_SECRET>；
 * 未配置 CRON_SECRET 时端点禁用（403），防止无鉴权触发定时任务。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { fetchAllPlatformModels } from "../../../worker/src/model-fetcher";
import { handleScheduledReset } from "../../../worker/src/key-reset";
import { runArchiveTask } from "../../../worker/src/log-archiver";
import { runProxyHealthCheck } from "@/lib/upstream-proxy";

const CRON_ROUTES: Record<string, (db: D1Database, env?: { DB_TYPE?: string }) => Promise<unknown>> = {
  "model-fetch": fetchAllPlatformModels,
  "key-reset": handleScheduledReset,
  "log-archive": runArchiveTask,
  "proxy-health": runProxyHealthCheck,
};

/** 常量时间字符串比较，防止通过响应时差枚举 CRON_SECRET（与 auth.ts 实现一致） */
function timingSafeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.length !== bufB.length) {
    let result = bufA.length ^ bufB.length;
    for (let i = 0; i < bufA.length; i++) {
      result |= bufA[i] ^ (bufB[i % bufB.length] || 0);
    }
    return result === 0;
  }
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method Not Allowed" }); }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // 403 消息不泄露 CRON_SECRET 配置细节与指引（未配置/错误头的状态码差异与文档约定一致）
    return res.status(403).json({ success: false, error: "Forbidden" });
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string" || !timingSafeStringEqual(authHeader, `Bearer ${secret}`)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const param = req.query.cron;
  const task = Array.isArray(param) ? param[0] : param;
  const VALID_TASKS = ["model-fetch", "key-reset", "log-archive", "proxy-health"];
  if (!task || !VALID_TASKS.includes(task)) {
    return res.status(404).json({ error: "Not Found" });
  }

  const dummyDb = {} as D1Database;
  const env = { DB_TYPE: process.env.DB_TYPE };
  const start = Date.now();

  try {
    console.log(`[cron] 开始: ${task}`);
    const result = await CRON_ROUTES[task](dummyDb, env);
    const elapsed = Date.now() - start;
    console.log(`[cron] ${task} 完成 (${elapsed}ms)`);
    if (result && typeof result === "object" && "success" in result) return res.status(200).json({ task, elapsed, ...result });
    return res.status(200).json({ success: true, task, elapsed, message: `${task} 完成` });
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cron] ${task} 失败 (${elapsed}ms):`, msg);
    // 不向调用方回显内部错误细节，避免泄露 DB/内部实现信息
    return res.status(500).json({ success: false, task, elapsed, error: "任务执行失败" });
  }
}
