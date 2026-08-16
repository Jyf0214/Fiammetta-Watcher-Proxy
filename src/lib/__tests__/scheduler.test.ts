import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createScheduler,
  matchesSchedule,
  startScheduler,
  DOCKER_TASKS,
  __resetSchedulerForTests,
} from "../scheduler";

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

describe("DOCKER_TASKS 任务表与文档频率一致", () => {
  /** 归一化 spec 为可比较形状（排序后的分钟/小时数组，空 = 每分钟/每小时） */
  const normalize = (t: (typeof DOCKER_TASKS)[number]) => [
    t.name,
    [...(t.spec.minutes ?? [])].sort((a, b) => a - b),
    [...(t.spec.hours ?? [])].sort((a, b) => a - b),
  ];

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

  it("proxy-health 分钟集合 = 分钟 % 5 == 2 的完整 12 个值", () => {
    const health = DOCKER_TASKS.find((t) => t.name === "proxy-health");
    const expected = Array.from({ length: 12 }, (_, i) => i * 5 + 2);
    expect([...(health?.spec.minutes ?? [])].sort((a, b) => a - b)).toEqual(expected);
  });
});