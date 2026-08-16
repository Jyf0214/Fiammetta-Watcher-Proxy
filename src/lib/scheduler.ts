// ================================================================
// Docker 内部定时调度器
//
// 非 Cloudflare 部署下，/api/cron/* 端点依赖外部调度器定时调用。
// Docker 部署（DEPLOY_PLATFORM=docker）由本调度器在容器内自动执行
// 全部定时任务，无需外部调用（也无需配置 CRON_SECRET——任务直连
// 函数而非走 HTTP 端点）。
//
// 入口：instrumentation.ts 的 register() 在 next start / standalone
// server.js 启动时调用 startScheduler()。Node 直部署等非 docker
// 平台不受影响（门控返回）。
// ================================================================

import { fetchAllPlatformModels } from "../../worker/src/model-fetcher";
import { handleScheduledReset } from "../../worker/src/key-reset";
import { runArchiveTask } from "../../worker/src/log-archiver";
import { runProxyHealthCheck, pullProxyGroups } from "./upstream-proxy";

/** 任务触发时间规格：分钟/小时集合匹配（分钟为空 = 每分钟，小时为空 = 每小时） */
export interface ScheduleSpec {
  minutes?: Set<number>;
  hours?: Set<number>;
}

/** 调度任务：到点执行 run()（返回值仅用于调度器忽略），异常被捕获记日志，不影响其他任务 */
export interface ScheduledTask {
  name: string;
  spec: ScheduleSpec;
  run: () => Promise<unknown>;
}

/** 当前时间是否命中调度规格（按本地时区） */
export function matchesSchedule(spec: ScheduleSpec, date: Date): boolean {
  if (spec.minutes && !spec.minutes.has(date.getMinutes())) return false;
  if (spec.hours && !spec.hours.has(date.getHours())) return false;
  return true;
}

/** 调度器实例：start() 后按 tickMs 周期检查任务，stop() 停止（供测试清理） */
export function createScheduler(
  tasks: ScheduledTask[],
  opts: { tickMs?: number; firstTickDelayMs?: number } = {}
): { start: () => void; stop: () => void } {
  const tickMs = opts.tickMs ?? 60_000;
  const firstTickDelayMs = opts.firstTickDelayMs ?? 30_000;

  const running = new Set<string>();
  /** 最近一次触发的时间键（HH:mm），防止同一分钟重复触发 */
  const lastRunKey = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const tick = async () => {
    const now = new Date();
    for (const task of tasks) {
      if (running.has(task.name)) continue; // 上一轮未完成则跳过，不积压
      if (!matchesSchedule(task.spec, now)) continue;
      const key = `${now.getHours()}:${now.getMinutes()}`;
      if (lastRunKey.get(task.name) === key) continue;

      lastRunKey.set(task.name, key);
      running.add(task.name);
      // 不 await：任务耗时可能超过 tick 周期，串行等待会让调度停摆
      void task
        .run()
        .catch((err) => {
          console.error(
            `[scheduler] ${task.name} 执行失败:`,
            err instanceof Error ? err.message : String(err)
          );
        })
        .finally(() => {
          running.delete(task.name);
        });
    }
  };

  return {
    start() {
      if (timer || stopped) return;
      timer = setTimeout(() => {
        timer = setInterval(() => void tick().catch(handleTickError), tickMs);
        void tick().catch(handleTickError);
      }, firstTickDelayMs);
    },
    // stop 只停止后续调度：进行中的任务继续跑完；同一实例 stop 后不可再 start
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}

/** tick 循环兜底：任何同步/异步异常都不允许逃逸到 unhandledRejection 崩溃进程 */
function handleTickError(err: unknown): void {
  console.error(
    "[scheduler] 调度循环异常:",
    err instanceof Error ? err.message : String(err)
  );
}

let schedulerStarted = false;

/** 仅测试用：重置全局单例标志，允许测试间重复调用 startScheduler */
export function __resetSchedulerForTests(): void {
  schedulerStarted = false;
}

/**
 * Docker 内部定时任务表（导出供测试断言 spec 与文档频率一致）
 *
 * 频率对齐 docs/api/cron.md 建议值，分钟错开避免并发写库：
 * - model-fetch  模型发现    每 6 小时（:05）
 * - key-reset    Key 用量重置 每小时（:00）
 * - log-archive  日志归档    每天 3:10（错开 3:00 的 key-reset，避免并发写库）
 * - proxy-health 代理健康检查 每 5 分钟（分钟 % 5 == 2）
 * - proxy-pull   代理列表拉取 每小时（:17）
 */
// 与 /api/cron/[[...cron]].ts 端点一致：非 d1 方言下 createDb 忽略传入的 DB
// binding，仅用 process.env（DB_TYPE / DATABASE_URL）建立连接
const db = {} as D1Database;
const env = { DB_TYPE: process.env.DB_TYPE };

export const DOCKER_TASKS: ScheduledTask[] = [
  {
    name: "model-fetch",
    spec: { minutes: new Set([5]), hours: new Set([0, 6, 12, 18]) },
    run: () => fetchAllPlatformModels(db, env),
  },
  {
    name: "key-reset",
    spec: { minutes: new Set([0]) },
    run: () => handleScheduledReset(db, env),
  },
  {
    name: "log-archive",
    spec: { minutes: new Set([10]), hours: new Set([3]) },
    run: () => runArchiveTask(db, env),
  },
  {
    name: "proxy-health",
    spec: {
      minutes: new Set([2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57]),
    },
    run: () => runProxyHealthCheck(db, env),
  },
  {
    name: "proxy-pull",
    spec: { minutes: new Set([17]) },
    run: () => pullProxyGroups(db, env),
  },
];

/**
 * 启动 Docker 内部定时器（全局单例，instrumentation register 调用）
 */
export function startScheduler(): void {
  if (process.env.DEPLOY_PLATFORM !== "docker") return;
  if (schedulerStarted) return;
  schedulerStarted = true;

  const scheduler = createScheduler(DOCKER_TASKS);
  console.log("[scheduler] Docker 内部定时器已启动（model-fetch / key-reset / log-archive / proxy-health / proxy-pull）");
  scheduler.start();

  // 进程退出时无需显式清理：调度器随服务进程生命周期终止
}