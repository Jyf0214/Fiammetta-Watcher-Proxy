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
import { loadWhitelist, loadKeyStatusFromKV } from "./platform-keys";
import { formatAnthropicError } from "@/lib/anthropic";
import type { WorkerEnv } from "./config";

export interface Env extends WorkerEnv {
  DB: D1Database;
  KV: KVNamespace;
}

/** 白名单是否已加载（内存态，Worker 冷启动后首次请求时加载） */
let whitelistLoaded = false;

/**
 * 将 Worker 环境变量同步到 process.env
 *
 * lib/prisma.ts 的数据库类型解析同时读取 env 对象与 process.env，
 * 而各业务模块只把 { DB, DB_TYPE } 传给 createDb，DATABASE_URL 等
 * Secret/Var 不会进入解析链，导致 Worker 永远推断为 d1（状态写入错误的库）。
 * 在入口统一同步，保证所有 createDb 调用都能解析到正确的数据库类型。
 */
function syncWorkerEnv(env: Env): void {
  if (env.DB_TYPE) process.env.DB_TYPE = env.DB_TYPE;
  if (env.DATABASE_URL) process.env.DATABASE_URL = env.DATABASE_URL;
  if (env.TIDB_URL) process.env.TIDB_URL = env.TIDB_URL;
  if (env.PG_URL) process.env.PG_URL = env.PG_URL;
  if (env.MARIADB_URL) process.env.MARIADB_URL = env.MARIADB_URL;
  if (env.HYPERDRIVE) process.env.HYPERDRIVE = JSON.stringify(env.HYPERDRIVE);
}

export default {
  /**
   * HTTP 请求处理 — 代理 /v1/* 路由
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 将 Worker 环境变量写入 process.env，供 lib/prisma.ts 工厂函数读取
    syncWorkerEnv(env);

    const url = new URL(request.url);

    try {
      // 首次请求时加载白名单与 Key 封禁状态（懒初始化）
      if (!whitelistLoaded) {
        whitelistLoaded = true;
        ctx.waitUntil(
          Promise.allSettled([
            loadWhitelist(env.DB, env),
            loadKeyStatusFromKV(env.DB, env.KV, env),
          ])
        );
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
        return await handleV1Route(request, env, ctx);
      }

      return new Response(
        JSON.stringify({ error: { message: "Not Found", type: "invalid_request_error" } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : undefined;
      console.error(
        `[worker] 未捕获异常: ${url.pathname} ${request.method}`,
        errorMessage,
        errorStack
      );
      // Anthropic 端点（/v1/messages、count_tokens）意外异常按协议格式化，
      // 与 Pages 入口外层 catch 行为一致
      if (url.pathname === "/v1/messages" || url.pathname === "/v1/messages/count_tokens") {
        return Response.json(formatAnthropicError(500, "服务器内部错误"), { status: 500 });
      }
      return Response.json(
        {
          error: {
            message: "服务器内部错误",
            type: "server_error",
          },
        },
        { status: 500 }
      );
    }
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
    // 与 fetch 入口一致，先同步环境变量（Cron 触发时同样需要正确的数据库连接）
    syncWorkerEnv(env);

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
