import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createScheduler,
  matchesSchedule,
  startScheduler,
  DOCKER_TASKS,
  healthCheckSpec,
  __resetSchedulerForTests,
  type ScheduleSpec,
} from "../scheduler";
import { PROXY_HEALTH_INTERVAL_MIN_RANGE } from "../upstream-proxy";

/** 解析任务 spec（支持函数形式：取当前求值结果） */
function resolveSpec(spec: ScheduleSpec | (() => ScheduleSpec)): ScheduleSpec {
  return typeof spec === "function" ? spec() : spec;
}

describe("matchesSchedule 调度匹配", () => {
  it("分钟集合命中 → true；未命中 → false", () => {
    const spec = { minutes: new Set([17]) };
    expect(matchesSchedule(spec, new Date(2026, 7, 16, 10, 17))).toBe(true);
    expect(matchesSchedule(spec, new Date(2026, 7, 16, 10, 16))).toBe(false);
  });

  it("小时集合命中（分钟未限定 = 每分钟）→ true", () => {
    const spec = { hours: new Set([3]) };
    expect(matchesSchedule(spec, new Date(2026, 7, 16, 3, 59))).toBe(true);
    expect(matchesSchedule(spec, new Date(2026, 7, 16, 4, 0))).toBe(false);
  });

  it("分钟 + 小时组合必须同时命中", () => {
    const spec = { minutes: new Set([10]), hours: new Set([3]) };
    expect(matchesSchedule(spec, new Date(2026, 7, 16, 3, 10))).toBe(true);
    expect(matchesSchedule(spec, new Date(2026, 7, 16, 3, 11))).toBe(false);
    expect(matchesSchedule(spec, new Date(2026, 7, 16, 4, 10))).toBe(false);
  });

  it("空规格 = 每分钟每小时都命中", () => {
    expect(matchesSchedule({}, new Date(2026, 7, 16, 0, 0))).toBe(true);
    expect(matchesSchedule({}, new Date(2026, 7, 16, 23, 59))).toBe(true);
  });
});

describe("createScheduler 调度执行", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("首个 tick 延迟后执行命中任务；下一 tick 未命中不执行", async () => {
    const runA = vi.fn().mockResolvedValue(undefined);
    const s = createScheduler(
      [{ name: "a", spec: { minutes: new Set([5]) }, run: runA }],
      { tickMs: 60_000, firstTickDelayMs: 30_000 }
    );
    // 10:05:30 首 tick 命中
    vi.setSystemTime(new Date(2026, 7, 16, 10, 5, 0));
    s.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runA).toHaveBeenCalledTimes(1);

    // 10:06:30 不命中
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runA).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it("同一分钟内多次 tick 只触发一次（lastRunKey 去重）", async () => {
    const runA = vi.fn().mockResolvedValue(undefined);
    const s = createScheduler(
      [{ name: "a", spec: { minutes: new Set([5]) }, run: runA }],
      { tickMs: 10_000, firstTickDelayMs: 0 }
    );
    // 10:05:00 首 tick 命中，之后每 10s 一次 tick；10:05:00~10:05:50 六个 tick
    // 都命中分钟 5，但同一分钟只执行一次
    vi.setSystemTime(new Date(2026, 7, 16, 10, 5, 0));
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runA).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it("下一命中分钟恢复触发", async () => {
    const runA = vi.fn().mockResolvedValue(undefined);
    const s = createScheduler(
      [{ name: "a", spec: { minutes: new Set([5]) }, run: runA }],
      { tickMs: 60_000, firstTickDelayMs: 0 }
    );
    vi.setSystemTime(new Date(2026, 7, 16, 10, 5, 0));
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runA).toHaveBeenCalledTimes(1);
    // 连续 tick：10:06:30 ... → 下一次命中分钟 5 是 11:05:30
    await vi.advanceTimersByTimeAsync(60_000 * 60);
    expect(runA).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it("任务仍在执行（pending）时跳过，不并发重入，完成后可再次触发", async () => {
    let resolveRun!: () => void;
    const runA = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        })
    );
    const s = createScheduler(
      [{ name: "a", spec: { minutes: new Set([5]) }, run: runA }],
      { tickMs: 60_000, firstTickDelayMs: 0 }
    );
    vi.setSystemTime(new Date(2026, 7, 16, 10, 5, 0));
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runA).toHaveBeenCalledTimes(1);

    // pending 期间推进 2 个 tick（10:06:30 / 10:07:30，不命中但即使命中也不重入）
    await vi.advanceTimersByTimeAsync(60_000 * 2);
    expect(runA).toHaveBeenCalledTimes(1);

    // 完成后下一命中分钟恢复触发（11:05:30）
    resolveRun();
    await vi.advanceTimersByTimeAsync(60_000 * 58);
    expect(runA).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it("任务异常被捕获记日志，不影响其他任务与后续触发", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runA = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(undefined);
    const runB = vi.fn().mockResolvedValue(undefined);
    const s = createScheduler(
      [
        { name: "a", spec: { minutes: new Set([5]) }, run: runA },
        { name: "b", spec: { minutes: new Set([5]) }, run: runB },
      ],
      { tickMs: 60_000, firstTickDelayMs: 0 }
    );
    vi.setSystemTime(new Date(2026, 7, 16, 10, 5, 0));
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runA).toHaveBeenCalledTimes(1);
    expect(runB).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[scheduler] a 执行失败"),
      "boom"
    );

    // 异常后下一命中分钟照常触发（11:05:30）
    await vi.advanceTimersByTimeAsync(60_000 * 60);
    expect(runA).toHaveBeenCalledTimes(2);
    s.stop();
    errorSpy.mockRestore();
  });

  it("stop 后不再触发", async () => {
    const runA = vi.fn().mockResolvedValue(undefined);
    const s = createScheduler(
      [{ name: "a", spec: { minutes: new Set([5]) }, run: runA }],
      { tickMs: 60_000, firstTickDelayMs: 0 }
    );
    vi.setSystemTime(new Date(2026, 7, 16, 10, 5, 0));
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runA).toHaveBeenCalledTimes(1);
    s.stop();
    await vi.advanceTimersByTimeAsync(60_000 * 60);
    expect(runA).toHaveBeenCalledTimes(1);
  });
});

describe("startScheduler 入口门控", () => {
  const originalPlatform = process.env.DEPLOY_PLATFORM;

  afterEach(() => {
    process.env.DEPLOY_PLATFORM = originalPlatform;
    __resetSchedulerForTests();
    vi.useRealTimers();
  });

  it("非 docker 部署（未设置）→ 不启动，不抛错", () => {
    delete process.env.DEPLOY_PLATFORM;
    expect(() => startScheduler()).not.toThrow();
  });

  it("非 docker 部署（其他平台值）→ 不启动", () => {
    process.env.DEPLOY_PLATFORM = "edgeone";
    expect(() => startScheduler()).not.toThrow();
  });

  it("docker 部署 → 启动且全局单例（重复调用只启动一次）", async () => {
    process.env.DEPLOY_PLATFORM = "docker";
    process.env.DB_TYPE = "pg";
    vi.useFakeTimers();
    // 固定到不命中任何任务的时间（10:03），推进只验证启动日志与单例，
    // 不会真的执行任务（任务会连开发库）
    vi.setSystemTime(new Date(2026, 7, 16, 10, 3, 0));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // 首次调用启动（30s 首 tick 延迟，fake timers 下不会真的跑任务）
    startScheduler();
    await vi.advanceTimersByTimeAsync(30_000);
    const startLogs = logSpy.mock.calls.filter((c) => String(c[0]).includes("[scheduler]"));
    expect(startLogs.length).toBe(1);
    // 重复调用不重复启动
    startScheduler();
    await vi.advanceTimersByTimeAsync(120_000);
    const startLogs2 = logSpy.mock.calls.filter((c) => String(c[0]).includes("[scheduler]"));
    expect(startLogs2.length).toBe(1);
    logSpy.mockRestore();
  });
});

describe("healthCheckSpec 间隔生成", () => {
  it("间隔 5 → 2/7/12/.../57（与历史默认一致）", () => {
    expect([...healthCheckSpec(5).minutes!].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i * 5 + 2)
    );
  });

  it("间隔 1 → 每分钟（2~59）；间隔 60 → 仅 :02", () => {
    expect([...healthCheckSpec(1).minutes!].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 58 }, (_, i) => i + 2)
    );
    expect([...healthCheckSpec(60).minutes!].sort((a, b) => a - b)).toEqual([2]);
  });

  it("越界/非整数钳制到允许范围（0→1、99→60、2.7→2）", () => {
    expect([...healthCheckSpec(0).minutes!].length).toBe(58);
    expect([...healthCheckSpec(99).minutes!]).toEqual([2]);
    expect([...healthCheckSpec(2.7).minutes!].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 29 }, (_, i) => i * 2 + 2)
    );
  });

  it("范围常量与文档一致（1~60）", () => {
    expect(PROXY_HEALTH_INTERVAL_MIN_RANGE).toEqual({ min: 1, max: 60 });
  });
});

describe("函数形式 spec（每次 tick 动态求值）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spec 函数每次 tick 重新求值，返回值变化即时生效", async () => {
    let minutes = new Set([5]);
    const specFn = vi.fn(() => ({ minutes }));
    const runA = vi.fn().mockResolvedValue(undefined);
    const s = createScheduler(
      [{ name: "a", spec: specFn, run: runA }],
      { tickMs: 60_000, firstTickDelayMs: 0 }
    );
    vi.setSystemTime(new Date(2026, 7, 16, 10, 5, 0));
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runA).toHaveBeenCalledTimes(1);

    // 运行中切换 spec（模拟保存后配置更新）：下一 tick（10:06）命中新分钟并执行
    minutes = new Set([6]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runA).toHaveBeenCalledTimes(2);
    expect(specFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    s.stop();
  });
});

describe("DOCKER_TASKS 任务表与文档频率一致", () => {
  /** 归一化 spec 为可比较形状（排序后的分钟/小时数组，空 = 每分钟/每小时） */
  const normalize = (t: (typeof DOCKER_TASKS)[number]) => {
    const spec = resolveSpec(t.spec);
    return [
      t.name,
      [...(spec.minutes ?? [])].sort((a, b) => a - b),
      [...(spec.hours ?? [])].sort((a, b) => a - b),
    ];
  };

  it("5 个任务齐全，name/spec 与文档建议频率一致", () => {
    expect(DOCKER_TASKS.map(normalize)).toEqual([
      ["model-fetch", [5], [0, 6, 12, 18]], // 每 6 小时（:05）
      ["key-reset", [0], []], // 每小时（:00）
      ["log-archive", [10], [3]], // 每天 3:10（错开整点 key-reset）
      ["proxy-health", [2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57], []], // 每 5 分钟
      ["proxy-pull", [17], []], // 每小时（:17）
    ]);
  });

  it("任务名互不重复", () => {
    const names = DOCKER_TASKS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("proxy-health 默认间隔（5）分钟集合 = 分钟 % 5 == 2 的完整 12 个值", () => {
    const health = DOCKER_TASKS.find((t) => t.name === "proxy-health");
    expect(health).toBeDefined();
    // 默认配置未加载时动态 spec 按默认 5 分钟生成（与历史行为一致）
    const minutes = resolveSpec(health!.spec).minutes ?? [];
    const expected = Array.from({ length: 12 }, (_, i) => i * 5 + 2);
    expect([...minutes].sort((a, b) => a - b)).toEqual(expected);
  });
});