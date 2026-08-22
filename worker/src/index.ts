/**
 * Worker 入口 — 处理 v1 代理请求 + Cron 定时任务
 *
 * 职责：
 * - /v1/* 路径 → handleV1Route（API 代理）
 * - 其他路径 → 404
 * - scheduled 事件 → Cron 任务分发（模型发现、Key 重置、日志归档、代理健康检查、代理列表拉取）
 *
 * D1 和 KV 通过 Wrangler Bindings 注入。
 */

import { handleV1Route } from "./v1-route";
import { classifyCronExpression } from "./types";
import { fetchAllPlatformModels } from "./model-fetcher";
import { handleScheduledReset } from "./key-reset";
import { runArchiveTask } from "./log-archiver";
import { loadWhitelist, loadKeyStatusFromKV } from "./platform-keys";
import { runProxyHealthCheck, pullProxyGroups, isScheduledProxyHealthDisabled, isUpstreamProxyDisabled } from "@/lib/upstream-proxy";
import { syncWorkerEnv } from "./env-sync";
import { formatAnthropicError } from "@/lib/anthropic";
import type { WorkerEnv } from "./config";

export interface Env extends WorkerEnv {
  DB: D1Database;
  KV: KVNamespace;
}

/** 白名单与 Key 状态是否已加载（内存态，Worker 冷启动后首次请求时加载） */
let whitelistLoaded = false;

/** 首次加载单飞 promise：并发首个请求共享同一加载，避免重复加载 */
let whitelistLoadPromise: Promise<boolean> | null = null;

export default {
  /**
   * HTTP 请求处理 — 代理 /v1/* 路由
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 将 Worker 环境变量写入 process.env，供 lib/prisma.ts 工厂函数读取
    syncWorkerEnv(env);

    const url = new URL(request.url);

    try {
      // 首次请求时加载白名单与 Key 封禁状态（懒初始化）：
      // await 阻塞保证首请求就基于已加载的豁免/禁用集合判定（waitUntil 不阻塞，
      // 首请求会在加载完成前进入路由，白名单豁免/禁用恢复对首个请求不生效）；
      // 成功全部加载后才置位 loaded 标志——任一失败（DB 瞬时故障）时保持 false，
      // 下次请求自动重试（此前先置位，失败后进程生命周期内永不重试，白名单豁免
      // 与持久化禁用恢复永久失效）；loadWhitelist/loadKeyStatusFromKV 内部已容错
      // （失败仅记日志并返回 false），whitelistLoadPromise 单飞保证并发首请求
      // 只加载一次
      if (!whitelistLoaded) {
        if (!whitelistLoadPromise) {
          whitelistLoadPromise = Promise.all([
            loadWhitelist(env.DB, env),
            loadKeyStatusFromKV(env.DB, env.KV, env),
          ])
            .then((results) => results.every(Boolean))
            .catch(() => false);
        }
        whitelistLoaded = await whitelistLoadPromise;
        whitelistLoadPromise = null;
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
   * 模型发现（每 6 小时）
   * Key 用量重置（每小时）
   * 日志归档（每天凌晨 3 点）
   * 出站代理健康检查（每 5 分钟，仅 Docker 部署且未禁用时生效）
   * 出站代理列表拉取（每分钟触发，按组内部周期判定是否到期）
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
      case "proxy-health":
        // 设备级禁用（UPSTREAM_PROXY_DISABLED=all/health）时跳过，与 Pages Cron 行为一致
        if (isScheduledProxyHealthDisabled()) {
          console.log("[cron] proxy-health 已跳过（设备级禁用）");
        } else {
          ctx.waitUntil(runProxyHealthCheck(env.DB, env));
        }
        break;
      case "proxy-pull":
        // 设备级整体禁用（UPSTREAM_PROXY_DISABLED=all）时跳过，与 Pages Cron 行为一致
        if (isUpstreamProxyDisabled()) {
          console.log("[cron] proxy-pull 已跳过（设备级禁用）");
        } else {
          ctx.waitUntil(pullProxyGroups(env.DB, env));
        }
        break;
      default:
        console.warn(`[cron] 未知的 cron 表达式: ${event.cron}`);
    }
  },
};
