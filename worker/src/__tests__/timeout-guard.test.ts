/**
 * timeout-guard.ts 上游总超时守卫测试
 *
 * 覆盖（对齐模块语义契约，fake timers 驱动）：
 * - 到点触发：onTimeout 恰好执行一次；配合 controller.abort() 后 signal 变 aborted
 * - 清理幂等：clear 后不再触发；重复 clear 安全；触发后再 clear 安全
 * - 多实例互不干扰
 * - onTimeout 异常不被吞掉（冒泡至定时器触发点）
 * - 参数非法显式抛错（timeoutMs / onTimeout）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createUpstreamTimeoutGuard } from "../proxy-core/timeout-guard";

describe("createUpstreamTimeoutGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("未到时不触发，到点恰好触发一次", () => {
    const onTimeout = vi.fn();
    const guard = createUpstreamTimeoutGuard({ timeoutMs: 120_000, onTimeout });

    vi.advanceTimersByTime(119_999);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    // 单次定时器不重复触发
    vi.advanceTimersByTime(120_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    guard.clear();
  });

  it("onTimeout 内 abort 后 guard.signal 变为 aborted（三端现状判定写法）", () => {
    const guard = createUpstreamTimeoutGuard({
      timeoutMs: 120_000,
      onTimeout: () => guard.controller.abort(),
    });
    expect(guard.signal.aborted).toBe(false);

    vi.advanceTimersByTime(120_000);
    expect(guard.signal.aborted).toBe(true);
    guard.clear();
  });

  it("clear 后到点不触发；重复 clear 幂等安全", () => {
    const onTimeout = vi.fn();
    const guard = createUpstreamTimeoutGuard({ timeoutMs: 120_000, onTimeout });

    guard.clear();
    expect(() => guard.clear()).not.toThrow();
    expect(() => guard.clear()).not.toThrow();

    vi.advanceTimersByTime(1_000_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("触发后再 clear 安全（clearTimeout 对已触发定时器为 no-op）", () => {
    const onTimeout = vi.fn();
    const guard = createUpstreamTimeoutGuard({ timeoutMs: 60_000, onTimeout });

    vi.advanceTimersByTime(60_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(() => guard.clear()).not.toThrow();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("signal 恒等于 controller.signal 且跨访问稳定；各实例相互独立", () => {
    const guard = createUpstreamTimeoutGuard({ timeoutMs: 120_000, onTimeout: vi.fn() });
    expect(guard.signal).toBe(guard.controller.signal);
    expect(guard.signal).toBe(guard.signal);

    const other = createUpstreamTimeoutGuard({ timeoutMs: 120_000, onTimeout: vi.fn() });
    expect(other.controller).not.toBe(guard.controller);
    expect(other.signal).not.toBe(guard.signal);
    guard.clear();
    other.clear();
  });

  it("多实例互不影响：clear 其一，另一仍按时触发", () => {
    const firstOnTimeout = vi.fn();
    const secondOnTimeout = vi.fn();
    const first = createUpstreamTimeoutGuard({ timeoutMs: 30_000, onTimeout: firstOnTimeout });
    const second = createUpstreamTimeoutGuard({ timeoutMs: 60_000, onTimeout: secondOnTimeout });

    first.clear();
    vi.advanceTimersByTime(30_000);
    expect(firstOnTimeout).not.toHaveBeenCalled();
    expect(secondOnTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(30_000);
    expect(firstOnTimeout).not.toHaveBeenCalled();
    expect(secondOnTimeout).toHaveBeenCalledTimes(1);
    second.clear();
  });

  it("onTimeout 抛错不被吞掉（冒泡至定时器触发点）", () => {
    const guard = createUpstreamTimeoutGuard({
      timeoutMs: 1_000,
      onTimeout: () => {
        throw new Error("onTimeout boom");
      },
    });
    expect(() => vi.advanceTimersByTime(1_000)).toThrow("onTimeout boom");
    // 冒泡后守卫仍可正常清理
    expect(() => guard.clear()).not.toThrow();
  });
});

describe("createUpstreamTimeoutGuard — 参数校验", () => {
  it("timeoutMs 非正/非有限数值抛 RangeError", () => {
    expect(() => createUpstreamTimeoutGuard({ timeoutMs: 0, onTimeout: vi.fn() })).toThrow(RangeError);
    expect(() => createUpstreamTimeoutGuard({ timeoutMs: -1, onTimeout: vi.fn() })).toThrow(RangeError);
    expect(() => createUpstreamTimeoutGuard({ timeoutMs: NaN, onTimeout: vi.fn() })).toThrow(RangeError);
    expect(() => createUpstreamTimeoutGuard({ timeoutMs: Infinity, onTimeout: vi.fn() })).toThrow(RangeError);
  });

  it("onTimeout 非函数抛 TypeError", () => {
    expect(() =>
      createUpstreamTimeoutGuard({
        timeoutMs: 1_000,
        onTimeout: undefined as unknown as () => void,
      })
    ).toThrow(TypeError);
  });
});
