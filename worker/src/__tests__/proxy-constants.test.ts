/**
 * proxy-constants 单元测试
 *
 * 验证 retryBackoffMs 指数退避 + 抖动的行为边界：
 * - attempt 0~3 单调递增
 * - attempt ≥ 6 收敛到 10s + jitter 上限（封顶 10s，不再线性增长）
 * - 抖动范围稳定在 [base, base+250)
 * - 上限 10s 是用户要求的"指数回退值上限为 10"的契约
 */

import { describe, it, expect } from "vitest";

const { retryBackoffMs } = await import("../proxy-core/proxy-constants");

/** 退避公式基准（不含 jitter）：min(250 * 2^attempt, 10000) */
function expectedBase(attempt: number): number {
  return Math.min(250 * Math.pow(2, attempt), 10000);
}

describe("retryBackoffMs", () => {
  it("attempt 0~6 基准值符合 250 * 2^attempt，封顶 10000", () => {
    for (const attempt of [0, 1, 2, 3, 4, 5, 6, 7, 10, 20]) {
      const base = expectedBase(attempt);
      // 跑 50 次采样，确保不超界
      for (let i = 0; i < 50; i++) {
        const v = retryBackoffMs(attempt);
        expect(v).toBeGreaterThanOrEqual(base);
        expect(v).toBeLessThan(base + 250);
      }
    }
  });

  it("attempt 0 基准为 250ms", () => {
    for (let i = 0; i < 20; i++) {
      const v = retryBackoffMs(0);
      expect(v).toBeGreaterThanOrEqual(250);
      expect(v).toBeLessThan(500);
    }
  });

  it("attempt 6 起封顶 10000ms（250 * 2^6 = 16000 → clamp 到 10000）", () => {
    for (let i = 0; i < 20; i++) {
      const v = retryBackoffMs(6);
      expect(v).toBeGreaterThanOrEqual(10000);
      expect(v).toBeLessThan(10250);
    }
  });

  it("attempt 20 仍封顶 10000ms（不退化）", () => {
    for (let i = 0; i < 20; i++) {
      const v = retryBackoffMs(20);
      expect(v).toBeGreaterThanOrEqual(10000);
      expect(v).toBeLessThan(10250);
    }
  });

  it("绝对不超过 10250ms（10s + jitter 上限）", () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      for (let i = 0; i < 10; i++) {
        const v = retryBackoffMs(attempt);
        expect(v).toBeLessThan(10250);
      }
    }
  });
});
