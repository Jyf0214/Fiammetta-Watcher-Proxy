/**
 * Worker 入口（lite 版）— 纯负载均衡代理 + 平台信息拉取
 *
 * VERSION=lite 时构建使用（见 scripts/worker-lite-gate.sh），以最小化 CPU 运行时间：
 * - /v1/* 路径 → 单次尝试代理（不重试、不封禁、不熔断、不评分、不按优先级）
 * - scheduled 事件 → 仅模型发现（拉取平台信息）；评分/Key 重置/日志归档均不注册
 * - 只写请求日志（request_logs），不做 Key 用量更新、速率限制、模板注入
 *
 * 与全量版 index.ts 刻意保持独立：lite 构建不引入评分/熔断器/归档相关代码。
 */

import { handleV1RouteLite } from "./v1-route-lite";
import { classifyCronExpression } from "./types";
import { fetchAllPlatformModels } from "./model-fetcher";
import { loadWhitelist, loadKeyStatusFromKV } from "./platform-keys";
import { syncWorkerEnv } from "./env-sync";
import { formatAnthropicError } from "@/lib/anthropic";
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
    syncWorkerEnv(env);

    const url = new URL(request.url);

    try {
      // 首次请求时加载白名单与 Key 封禁状态（懒初始化；lite 只读不写）：
      // await 阻塞保证首请求就基于已加载的豁免/禁用集合判定；内部已容错，
      // 重复并发加载幂等无害（与全量版 index.ts 同模式）
      if (!whitelistLoaded) {
        whitelistLoaded = true;
        await Promise.allSettled([
          loadWhitelist(env.DB, env),
          loadKeyStatusFromKV(env.DB, env.KV, env),
        ]);
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
        return await handleV1RouteLite(request, env, ctx);
      }

      return new Response(
        JSON.stringify({ error: { message: "Not Found", type: "invalid_request_error" } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : undefined;
      console.error(
        `[worker-lite] 未捕获异常: ${url.pathname} ${request.method}`,
        errorMessage,
        errorStack
      );
      // Anthropic 端点（/v1/messages、count_tokens）意外异常按协议格式化，
      // 与全量版入口外层 catch 行为一致
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
   * Cron 定时任务处理（lite：仅模型发现，其余任务一律不执行）
   *
   * 注册的 cron 表达式由 wrangler-lite 配置裁剪为模型发现一项；
   * 这里对未知表达式仅告警，不执行任何评分/重置/归档逻辑。
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // 与 fetch 入口一致，先同步环境变量（Cron 触发时同样需要正确的数据库连接）
    syncWorkerEnv(env);

    const task = classifyCronExpression(event.cron);

    switch (task) {
      case "model-fetch":
        ctx.waitUntil(fetchAllPlatformModels(env.DB, env));
        break;
      default:
        // lite 版不注册评分/Key 重置/日志归档任务，其余表达式视为无效
        console.warn(`[worker-lite] 忽略非模型发现任务: ${event.cron}`);
    }
  },
};
