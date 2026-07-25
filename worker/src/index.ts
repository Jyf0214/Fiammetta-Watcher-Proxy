/**
 * Worker 入口 — 处理 v1 代理请求 + Cron 定时任务
 *
 * 职责：
 * - /v1/* 路径 → handleV1Route（API 代理）
 * - 其他路径 → 404
 * - scheduled 事件 → Cron 任务分发（模型发现、Key 重置、日志归档）
 *
 * D1 和 KV 通过 Wrangler Bindings 注入。
 */

import { handleV1Route } from "./v1-route";
import { classifyCronExpression } from "./types";
import { fetchAllPlatformModels } from "./model-fetcher";
import { handleScheduledReset } from "./key-reset";
import { runArchiveTask } from "./log-archiver";
import { loadWhitelist } from "./platform-keys";
import type { WorkerEnv } from "./config";

export interface Env extends WorkerEnv {
  DB: D1Database;
  KV: KVNamespace;
}

/** 白名单是否已加载（内存态，Worker 冷启动后首次请求时加载） */
let whitelistLoaded = false;

export default {
  /**
   * HTTP 请求处理 — 代理 /v1/* 路由
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 将 Worker 环境变量写入 process.env，供 lib/prisma.ts 工厂函数读取
    if (env.DB_TYPE) process.env.DB_TYPE = env.DB_TYPE;

    const url = new URL(request.url);

    // 首次请求时加载白名单（懒初始化）
    if (!whitelistLoaded) {
      whitelistLoaded = true;
      ctx.waitUntil(loadWhitelist(env.DB, env).catch((err) => {
        console.error("[worker] 白名单加载失败:", err);
      }));
    }

    // 健康检查端点
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", timestamp: Math.floor(Date.now() / 1000) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // v1 代理路由
    if (url.pathname.startsWith("/v1/")) {
      return handleV1Route(request, env, ctx);
    }

    return new Response(
      JSON.stringify({ error: { message: "Not Found", type: "invalid_request_error" } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  },

  /**
   * Cron 定时任务处理
   *
   * 根据 cron 表达式自动分发到对应任务：
   * 模型发现（每 10 分钟）
   * Key 用量重置（每小时）
   * 日志归档（每天凌晨 3 点）
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const task = classifyCronExpression(event.cron);

    switch (task) {
      case "model-fetch":
        ctx.waitUntil(fetchAllPlatformModels(env.DB, env));
        break;
      case "key-reset":
        ctx.waitUntil(handleScheduledReset(env.DB, env));
        break;
      case "log-archive":
        ctx.waitUntil(runArchiveTask(env.DB, env));
        break;
      default:
        console.warn(`[cron] 未知的 cron 表达式: ${event.cron}`);
    }
  },
};
