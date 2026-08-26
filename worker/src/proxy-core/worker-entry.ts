/**
 * Worker 入口骨架（proxy-core 第十块）
 *
 * worker/src/index.ts 全量版与 worker/src/index-lite.ts lite 版此前是两份
 * 逐字相同的入口骨架：Env 定义、白名单/Key 状态懒加载单飞、/health 端点、
 * /v1/* 分发、404 与外层 catch 错误格式化，以及 scheduled 的 cron 分发 switch。
 * 本模块把这些结构固化为唯一实现；业务链路以依赖注入方式接入——lite 构建
 * 靠 wrangler main 指向 index-lite.ts 后的 tree-shaking 裁剪产物，骨架层
 * 严禁静态 import 全量版模块（router/proxy/load-balancer/log-archiver 等），
 * 否则 lite 产物会被整体拉入全量代码。
 *
 * 注入契约：
 * - fetch 骨架只要求 routeHandler（handleV1Route / handleV1RouteLite）与
 *   日志前缀；
 * - cron 骨架按 classifyCronExpression 分类后查任务表执行，未注册的任务
 *   视为该部署形态不提供（lite 仅注册 model-fetch），未知表达式统一告警。
 */

import { loadWhitelist, loadKeyStatusFromKV } from "../platform-keys";
import { syncWorkerEnv } from "../env-sync";
import { classifyCronExpression, type CronTask } from "../types";
import { formatAnthropicError } from "@/lib/anthropic";
import type { WorkerEnv } from "../config";

/** Worker 入口环境（全量版与 lite 版同一形状：D1 + KV bindings + WorkerEnv） */
export interface WorkerEntryEnv extends WorkerEnv {
  DB: D1Database;
  KV: KVNamespace;
}

/** handleWorkerFetch 的依赖注入集 */
export interface WorkerFetchOptions {
  /** /v1/* 路由处理器（全量版 handleV1Route / lite 版 handleV1RouteLite） */
  routeHandler: (
    request: Request,
    env: WorkerEntryEnv,
    ctx: ExecutionContext
  ) => Promise<Response>;
  /** 未捕获异常日志前缀（"[worker]" / "[worker-lite]"） */
  logPrefix: string;
}

/** cron 任务表：分类命中的任务类型 → 执行闭包（未注册 = 该形态不提供） */
export type CronTaskMap = Partial<Record<CronTask, (ctx: ExecutionContext) => void>>;

/** 白名单与 Key 状态是否已加载（内存态，Worker 冷启动后首次请求时加载） */
let whitelistLoaded = false;

/** 首次加载单飞 promise：并发首个请求共享同一加载，避免重复加载 */
let whitelistLoadPromise: Promise<boolean> | null = null;

/**
 * 首次请求时加载白名单与 Key 封禁状态（懒初始化）：
 * await 阻塞保证首请求就基于已加载的豁免/禁用集合判定（waitUntil 不阻塞，
 * 首请求会在加载完成前进入路由，白名单豁免/禁用恢复对首个请求不生效）；
 * 成功全部加载后才置位 loaded 标志——任一失败（DB 瞬时故障）时保持 false，
 * 下次请求自动重试（此前先置位，失败后进程生命周期内永不重试，白名单豁免
 * 与持久化禁用恢复永久失效）；loadWhitelist/loadKeyStatusFromKV 内部已容错
 * （失败仅记日志并返回 false），whitelistLoadPromise 单飞保证并发首请求
 * 只加载一次
 */
export async function ensureProxyInit(env: WorkerEntryEnv): Promise<void> {
  if (whitelistLoaded) return;
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

/**
 * Worker fetch 入口骨架（全量版与 lite 版共用）
 *
 * 结构：env 同步 → 白名单懒加载 → /health → /v1/* 分发 → 404 → 外层 catch
 * （Anthropic 端点意外异常按协议格式化，其余返回 server_error）
 */
export async function handleWorkerFetch(
  request: Request,
  env: WorkerEntryEnv,
  ctx: ExecutionContext,
  opts: WorkerFetchOptions
): Promise<Response> {
  // 将 Worker 环境变量写入 process.env，供 lib/prisma.ts 工厂函数读取
  syncWorkerEnv(env);

  const url = new URL(request.url);

  try {
    await ensureProxyInit(env);

    // 健康检查端点
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", timestamp: Math.floor(Date.now() / 1000) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // v1 代理路由
    if (url.pathname.startsWith("/v1/")) {
      return await opts.routeHandler(request, env, ctx);
    }

    return new Response(
      JSON.stringify({ error: { message: "Not Found", type: "invalid_request_error" } }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    console.error(
      `${opts.logPrefix} 未捕获异常: ${url.pathname} ${request.method}`,
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
}

/**
 * Worker scheduled 入口骨架（全量版与 lite 版共用）
 *
 * 按 classifyCronExpression 分类后查任务表执行；任务闭包由各入口注入
 * （含设备级禁用判断与结果日志等形态特有逻辑）。调用方须先自行
 * syncWorkerEnv（骨架不重复做，避免两份同步语义）。
 */
export function dispatchCronTasks(
  event: ScheduledEvent,
  ctx: ExecutionContext,
  tasks: CronTaskMap
): void {
  const task = classifyCronExpression(event.cron);

  const handler = task ? tasks[task] : undefined;
  if (!handler) {
    // 未注册的分类任务（lite 不注册评分/Key 重置/日志归档等）与未知表达式
    // 一并告警：wrangler.toml 已裁剪 lite 的 crons 列表，正常不会命中
    console.warn(`[cron] 忽略未注册的 cron 任务: ${event.cron}${task ? ` (${task})` : ""}`);
    return;
  }
  handler(ctx);
}
