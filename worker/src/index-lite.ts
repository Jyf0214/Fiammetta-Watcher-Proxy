/**
 * Worker 入口（lite 版）— 单次尝试代理 + 平台信息拉取
 *
 * VERSION=lite 时构建使用（见 scripts/worker-lite-gate.sh），以最小化 CPU 运行时间：
 * - /v1/* 路径 → 单次尝试代理（不重试、不熔断平台、不评分、不按优先级）
 * - 密钥类错误（429/401/402/403）封禁 Key 并累加错误计数（达 5 次自动禁用，
 *   与全量版一致；HTTP 透传与流内 error 两条路径均执行）
 * - scheduled 事件 → 仅模型发现（拉取平台信息）；评分/Key 重置/日志归档均不注册
 * - 只写请求日志（request_logs），不做 Key 用量更新、速率限制、模板注入
 *
 * 入口骨架已收敛至 proxy-core/worker-entry.ts（与全量版共用同一实现）；
 * 本文件仅注入 lite 业务链路（handleV1RouteLite + model-fetch 任务），
 * 不引入评分/熔断器/归档相关代码——lite 构建依赖入口 tree-shaking。
 */

import { handleV1RouteLite } from "./v1-route-lite";
import { fetchAllPlatformModels } from "./model-fetcher";
import { syncWorkerEnv } from "./env-sync";
import { dispatchCronTasks, handleWorkerFetch, type WorkerEntryEnv, type CronTaskMap } from "./proxy-core/worker-entry";

export type Env = WorkerEntryEnv;

export default {
  /**
   * HTTP 请求处理 — 代理 /v1/* 路由
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleWorkerFetch(request, env, ctx, {
      routeHandler: handleV1RouteLite,
      logPrefix: "[worker-lite]",
    });
  },

  /**
   * Cron 定时任务处理（lite：仅模型发现，其余任务一律不执行）
   *
   * 注册的 cron 表达式由 wrangler-lite 配置裁剪为模型发现一项；
   * 未注册的表达式在共享分发骨架中统一告警，不执行任何评分/重置/归档逻辑。
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // 与 fetch 入口一致，先同步环境变量（Cron 触发时同样需要正确的数据库连接）
    syncWorkerEnv(env);

    const tasks: CronTaskMap = {
      "model-fetch": (c) => c.waitUntil(fetchAllPlatformModels(env.DB, env)),
    };

    dispatchCronTasks(event, ctx, tasks);
  },
};
