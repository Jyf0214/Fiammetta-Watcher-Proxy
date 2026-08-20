// ================================================================
// Docker 内部定时调度器
//
// 非 Cloudflare 部署下，/api/cron/* 端点依赖外部调度器定时调用。
// Docker 部署（DEPLOY_PLATFORM=docker）由本调度器在容器内自动执行
// 全部定时任务，无需外部调用（也无需配置 CRON_SECRET——任务直连
// 函数而非走 HTTP 端点）。
//
// 入口：scripts/build-scheduler.mjs 把本模块打包为独立进程产物
// .build/scheduler.cjs，docker-entrypoint 在容器启动时以后台进程
// 方式运行（脱离 Next.js 构建产物；instrumentation 方案会把调度器
// 链编入 Cloudflare Edge Worker 导致 Pages Function 体积超限，
// 已于 2026-08-18 移除）。Node 直部署等非 docker 平台不受影响（门控返回）。
// ================================================================

import { fetchAllPlatformModels } from "../../worker/src/model-fetcher";
import { handleScheduledReset } from "../../worker/src/key-reset";
import { runArchiveTask } from "../../worker/src/log-archiver";
import {
  runProxyHealthCheck,
  pullProxyGroups,
  getHealthCheckIntervalMin,
  isScheduledProxyHealthDisabled,
  PROXY_HEALTH_INTERVAL_MIN_RANGE,
} from "./upstream-proxy";

/** 供测试与文档断言健康检查间隔允许范围（与 upstream-proxy 常量一致） */
export { PROXY_HEALTH_INTERVAL_MIN_RANGE };

/** 任务触发时间规格：分钟/小时集合匹配（分钟为空 = 每分钟，小时为空 = 每小时） */
export interface ScheduleSpec {
  minutes?: Set<number>;
  hours?: Set<number>;
  /** 距上次执行完成的最小间隔（毫秒）：大代理池健康检查一轮可能远超触发
   *   间隔（数千代理 × 并发 20 × 超时 10s ≈ 30+ 分钟），固定分钟触发会
   *   退化为连续满负荷轮转；上一轮完成后未满间隔的触发一律跳过 */
  minIntervalMs?: number;
}

/**
 * 调度任务：到点执行 run()（返回值仅用于调度器忽略），异常被捕获记日志，不影响其他任务。
 * spec 支持函数形式：每次 tick 求值，供依赖运行时可配置项的周期类任务使用（如 proxy-health）
 */
export interface ScheduledTask {
  name: string;
  spec: ScheduleSpec | (() => ScheduleSpec);
  run: () => Promise<unknown>;
}

/**
 * 生成代理健康检查触发时刻：以固定偏移 2 分为锚点、按间隔步进（interval=5 时
 * 为 2/7/12/.../57，与历史默认行为一致）。间隔钳制到允许范围（1~1440）。
 *
 * ≤60 分钟：分钟级网格。间隔不整除 60 时（如 25、7），整数步进会在整点前后
 * 留下短尾间隙（interval=25 时 2/27/52，:52 后仅 10 分钟即到下一小时 :02，
 * 触发间隔变为 25/25/10 交替）。此时改用 60/k 浮点均匀步进取整：每小时触发
 * 次数 = floor(60/interval)，实际触发间隙 = 60/count 分钟（如 interval=25 时
 * 每小时 2 次、间隙 30 分钟；interval>30 时每小时仅 1 次、间隙 60 分钟）。
 * 整除间隔行为保持不变。
 *
 * >60 分钟：小时级网格。以锚点小时 2 为起点按 interval/60 步进（分钟固定 2
 * 分），取整小时后去重；interval=1440（24 小时）时仅锚点小时 2，每天 02:02
 * 触发一次。
 */
export function healthCheckSpec(intervalMin: number): ScheduleSpec {
  const interval = Math.min(
    Math.max(Math.trunc(intervalMin), PROXY_HEALTH_INTERVAL_MIN_RANGE.min),
    PROXY_HEALTH_INTERVAL_MIN_RANGE.max
  );
  if (interval > 60) {
    const hours = new Set<number>();
    const step = interval / 60;
    for (let h = 2; h < 24; h += step) {
      const hh = Math.round(h);
      if (hh >= 0 && hh < 24) hours.add(hh);
    }
    return { minutes: new Set([2]), hours };
  }
  const minutes = new Set<number>();
  if (60 % interval === 0) {
    // 整除间隔：保持历史步进行为（测试断言 5 → 2/7/12/.../57）
    for (let m = 2; m < 60; m += interval) minutes.add(m);
  } else {
    // 非整除间隔：60/k 均匀步进取整，避免尾部间隙缩短
    const count = Math.floor(60 / interval);
    const step = 60 / count;
    for (let i = 0; i < count; i++) minutes.add(Math.round(2 + i * step));
  }
  return { minutes };
}

/** 当前时间是否命中调度规格（按本地时区）；lastFinishedAtMs 用于 minIntervalMs 门控 */
export function matchesSchedule(
  spec: ScheduleSpec,
  date: Date,
  lastFinishedAtMs?: number
): boolean {
  if (spec.minIntervalMs && lastFinishedAtMs && date.getTime() - lastFinishedAtMs < spec.minIntervalMs) {
    return false;
  }
  // 空/未定义分钟集合 = 每分钟（size > 0 防御空 Set：空 Set 为 truthy 且
  // has() 恒 false，若不加判断会让「每分钟」规格永不命中）
  if (spec.minutes && spec.minutes.size > 0 && !spec.minutes.has(date.getMinutes())) return false;
  if (spec.hours && spec.hours.size > 0 && !spec.hours.has(date.getHours())) return false;
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
  /** 最近一次执行完成时间（ms）：minIntervalMs 门控依据 */
  const lastFinishedAt = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const tick = async () => {
    const now = new Date();
    for (const task of tasks) {
      if (running.has(task.name)) continue; // 上一轮未完成则跳过，不积压
      const spec = typeof task.spec === "function" ? task.spec() : task.spec;
      if (!matchesSchedule(spec, now, lastFinishedAt.get(task.name))) continue;
      const key = `${now.getHours()}:${now.getMinutes()}`;
      if (lastRunKey.get(task.name) === key) continue;

      lastRunKey.set(task.name, key);
      running.add(task.name);
      // 不 await：任务耗时可能超过 tick 周期，串行等待会让调度停摆
      void task
        .run()
        .then((result) => {
          // 任务返回 { success: false } 而非抛错时（如 log-archiver 的
          // runArchiveTask），失败会被静默吞掉——此处显式输出任务名与失败
          // 信息；lastFinishedAt 照常更新，失败后按周期重试是既有设计，
          // 只需让失败可见
          if (
            result &&
            typeof result === "object" &&
            "success" in result &&
            (result as { success?: boolean }).success === false
          ) {
            const detail =
              (result as { message?: string }).message ??
              (result as { error?: string }).error ??
              "success: false";
            console.error(`[scheduler] ${task.name} 执行失败:`, detail);
          }
        })
        .catch((err) => {
          console.error(
            `[scheduler] ${task.name} 执行失败:`,
            err instanceof Error ? err.message : String(err)
          );
        })
        .finally(() => {
          running.delete(task.name);
          lastFinishedAt.set(task.name, Date.now());
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
 * - proxy-health 代理健康检查 默认每 5 分钟（间隔可在出站代理管理页自定义，
 *   动态 spec 每次 tick 从进程内配置缓存读取，修改保存后于下一次检查生效）
 * - proxy-pull   代理列表拉取 每分钟 tick（组级自动更新：按每组的开关与周期
 *   判定是否到期，未到期组跳过；最小组周期 1 分钟）
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
    // minIntervalMs：上一轮完成后满一个间隔才再触发——大代理池一轮
    // （数千代理）远超触发间隔，固定分钟触发会退化为连续满负荷轮转；
    // 完成后的间隔内 tick 全部跳过，实际周期 = 一轮耗时 + 间隔
    spec: () => {
      const intervalMin = getHealthCheckIntervalMin();
      return { ...healthCheckSpec(intervalMin), minIntervalMs: intervalMin * 60_000 };
    },
    // 环境变量 UPSTREAM_PROXY_DISABLED=all/health 时定时健康检查跳过
    //（设备级禁用，不写库；管理页手动「立即检查」不受影响）
    run: () =>
      isScheduledProxyHealthDisabled()
        ? Promise.resolve({})
        : runProxyHealthCheck(db, env),
  },
  {
    name: "proxy-pull",
    // 每分钟 tick（空 spec = 无分钟/小时约束），到期判定在 pullProxyGroups
    // 内部按组进行（组级自动更新开关 + 周期；未到期/关闭自动更新的组跳过，
    // 任务本体是轻量读库判断）
    spec: {},
    run: () => pullProxyGroups(db, env),
  },
];

/**
 * 启动 Docker 内部定时器（全局单例，独立进程入口调用）
 */
export function startScheduler(): void {
  if (process.env.DEPLOY_PLATFORM !== "docker") return;
  if (schedulerStarted) return;
  schedulerStarted = true;

  const scheduler = createScheduler(DOCKER_TASKS);
  console.log("[scheduler] Docker 内部定时器已启动（model-fetch / key-reset / log-archive / proxy-health / proxy-pull）");
  scheduler.start();

  // 容器重启后立即拉取一次代理列表：proxy-pull 的首个触发周期最长要等
  // 一分钟，重启后不等调度周期即可刷新订阅源（幂等，与定时任务共用
  // pullProxyGroups；手动模式绕过组周期判定——启动拉取视为立即执行。
  // 无订阅地址的组/非 docker 部署内部返回空）
  void pullProxyGroups(db, env, { manual: true }).catch((err) => {
    console.error(
      "[scheduler] 启动时代理列表拉取失败:",
      err instanceof Error ? err.message : String(err)
    );
  });
}