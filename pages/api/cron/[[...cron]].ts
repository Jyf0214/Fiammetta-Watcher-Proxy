/**
 * 定时任务路由 — 通用 HTTP 端点
 *
 * 通过外部服务（如 Cron-job.org、UptimeRobot 等）定时调用：
 *   GET/POST /api/cron/model-fetch  → 拉取平台模型
 *   GET/POST /api/cron/key-reset    → 重置 Key 用量
 *   GET/POST /api/cron/log-archive  → 归档过期日志
 *
 * 认证：必须配置 CRON_SECRET 环境变量并携带 Authorization: Bearer <CRON_SECRET>；
 * 未配置 CRON_SECRET 时端点禁用（403），防止无鉴权触发定时任务。
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { fetchAllPlatformModels } from "../../../worker/src/model-fetcher";
import { handleScheduledReset } from "../../../worker/src/key-reset";
import { runArchiveTask } from "../../../worker/src/log-archiver";

const CRON_ROUTES: Record<string, (db: D1Database, env?: { DB_TYPE?: string }) => Promise<unknown>> = {
  "model-fetch": fetchAllPlatformModels,
  "key-reset": handleScheduledReset,
  "log-archive": runArchiveTask,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ error: "Method Not Allowed" }); }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(403).json({
      success: false,
      error: "Forbidden",
      message: "CRON_SECRET 未配置，定时任务端点已禁用。请在部署环境配置 CRON_SECRET 后由外部调度器携带 Authorization: Bearer <CRON_SECRET> 调用",
    });
  }
  if (req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "Unauthorized" });

  const param = req.query.cron;
  const task = Array.isArray(param) ? param[0] : param;
  if (!task || !(task in CRON_ROUTES)) return res.status(404).json({ error: "Not Found", message: `未知任务: ${task || "(空)"}`, available: Object.keys(CRON_ROUTES) });

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
    return res.status(500).json({ success: false, task, elapsed, error: msg });
  }
}
