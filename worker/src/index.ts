/**
 * Worker 入口（全量版）— 处理 v1 代理请求 + Cron 定时任务
 *
 * 入口骨架（白名单/Key 状态懒加载单飞、/health、404、外层 catch 错误格式化、
 * cron 分发）已收敛至 proxy-core/worker-entry.ts（与 lite 版共用同一实现），
 * 本文件仅注入全量版业务链路：
 * - /v1/* → handleV1Route（重试/熔断/评分/限流门禁全量代理）
 * - scheduled → 全部六类任务（模型发现、Key 重置、日志归档、代理健康检查、
 *   代理列表拉取、配置备份）
 *
 * D1 和 KV 通过 Wrangler Bindings 注入。
 */

import { handleV1Route } from "./v1-route";
import { fetchAllPlatformModels } from "./model-fetcher";
import { handleScheduledReset } from "./key-reset";
import { runArchiveTask } from "./log-archiver";
import { runProxyHealthCheck, pullProxyGroups, isScheduledProxyHealthDisabled, isUpstreamProxyDisabled } from "@/lib/upstream-proxy";
import { runBackupTask } from "@/lib/backup";
import { syncWorkerEnv } from "./env-sync";
import { dispatchCronTasks, handleWorkerFetch, type WorkerEntryEnv, type CronTaskMap } from "./proxy-core/worker-entry";

export type Env = WorkerEntryEnv;

export default {
  /**
   * HTTP 请求处理 — 代理 /v1/* 路由
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleWorkerFetch(request, env, ctx, {
      routeHandler: handleV1Route,
      logPrefix: "[worker]",
    });
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
   * 配置备份推送（每天 3:17）
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // 与 fetch 入口一致，先同步环境变量（Cron 触发时同样需要正确的数据库连接）
    syncWorkerEnv(env);

    // Env 为 wrangler 生成的具体接口（无索引签名），backup 任务按键名读取
    // BACKUP_* 变量，显式放宽为通用记录
    const tasks: CronTaskMap = {
      "model-fetch": (c) => c.waitUntil(fetchAllPlatformModels(env.DB, env)),
      "key-reset": (c) => c.waitUntil(handleScheduledReset(env.DB, env)),
      "log-archive": (c) => c.waitUntil(runArchiveTask(env.DB, env)),
      // 设备级禁用（UPSTREAM_PROXY_DISABLED=all/health）时跳过，与 Pages Cron 行为一致
      "proxy-health": (c) => {
        if (isScheduledProxyHealthDisabled()) {
          console.log("[cron] proxy-health 已跳过（设备级禁用）");
          return;
        }
        c.waitUntil(runProxyHealthCheck(env.DB, env));
      },
      // 设备级整体禁用（UPSTREAM_PROXY_DISABLED=all）时跳过，与 Pages Cron 行为一致
      "proxy-pull": (c) => {
        if (isUpstreamProxyDisabled()) {
          console.log("[cron] proxy-pull 已跳过（设备级禁用）");
          return;
        }
        c.waitUntil(pullProxyGroups(env.DB, env));
      },
      backup: (c) =>
        c.waitUntil(
          runBackupTask(env.DB, env as unknown as Record<string, unknown>).then((r) => {
            if (!r.success) console.error(`[cron] backup 失败: ${r.skipped}`);
            else if (r.skipped) console.log(`[cron] backup 跳过: ${r.skipped}`);
            else console.log(`[cron] backup 已推送 ${r.sizeBytes} 字节`);
          })
        ),
    };

    dispatchCronTasks(event, ctx, tasks);
  },
};
