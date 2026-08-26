/**
 * limit-gate.ts 四段式限流门禁核心测试
 *
 * 覆盖：
 * - 全通过路径：四段检查顺序、estimatedTokens 下发、halfOpenHeld 原样回传、
 *   无任何归还/钩子调用
 * - 四个 stage 各自的拒绝路径：短路（后续检查不执行）、归还集合与顺序
 *   （槽位 → 平台 RPM → 平台 TPM）、halfOpenHeld 条件释放（bug L5）、
 *   归还使用扣减时刻的平台级 windowStart（非被拒 Key 级结果的窗口键）、
 *   onGateRejected 收到正确的 stage 与原始结果
 * - platformRpm 拒绝：无配额归还（check 拒绝分支自身未扣减）
 * - release / 槽位释放抛错不影响结果（尽力而为语义）
 * - lite 空适配器组合：恒 allowed 无副作用 → allowed:true + halfOpenHeld:false
 */

import { describe, it, expect, vi } from "vitest";
import {
  runLimitGate,
  type LimitGateAdapters,
  type LimitGateInput,
  type RateLimitCheckResult,
} from "../proxy-core/limit-gate";

// ==================== mock 工具 ====================

const ok = (windowStart?: number): RateLimitCheckResult => ({
  allowed: true,
  resetAt: 1_000_000,
  windowStart,
});
const denied = (windowStart?: number): RateLimitCheckResult => ({
  allowed: false,
  resetAt: 1_000_060,
  windowStart,
});

/**
 * 可编程 mock 适配器：events 按时间序记录全部调用（含归还参数），
 * 用于断言执行顺序与归还集合。
 */
function makeMockAdapters(overrides: {
  pRpm?: RateLimitCheckResult;
  kRpm?: RateLimitCheckResult;
  pTpm?: RateLimitCheckResult;
  kTpm?: RateLimitCheckResult;
  /** 置 true 时所有 release（含槽位释放）一律抛错 */
  failReleases?: boolean;
}) {
  const events: string[] = [];

  const adapters: LimitGateAdapters = {
    checkPlatformRpm: vi.fn(async () => {
      events.push("check:pRpm");
      return overrides.pRpm ?? ok();
    }),
    checkApiKeyRpm: vi.fn(async () => {
      events.push("check:kRpm");
      return overrides.kRpm ?? ok();
    }),
    checkPlatformTpm: vi.fn(async (est: number) => {
      events.push(`check:pTpm:${est}`);
      return overrides.pTpm ?? ok();
    }),
    checkApiKeyTpm: vi.fn(async (est: number) => {
      events.push(`check:kTpm:${est}`);
      return overrides.kTpm ?? ok();
    }),
    releasePlatformRpm: vi.fn(async (ws?: number) => {
      events.push(`release:rpm:${ws ?? "none"}`);
      if (overrides.failReleases) throw new Error("rpm release failed");
    }),
    releasePlatformTpm: vi.fn(async (est: number, ws?: number) => {
      events.push(`release:tpm:${est}:${ws ?? "none"}`);
      if (overrides.failReleases) throw new Error("tpm release failed");
    }),
    releaseHalfOpenPending: vi.fn(async () => {
      events.push("release:slot");
      if (overrides.failReleases) throw new Error("slot release failed");
    }),
  };

  return { adapters, events };
}

/** 构造门禁入参：默认持有半开槽位、预扣 100 token */
function makeInput(overrides?: Partial<LimitGateInput>): LimitGateInput {
  return {
    initialHalfOpenHeld: true,
    estimatedTokens: 100,
    onGateRejected: vi.fn(),
    ...overrides,
  };
}

// ==================== 全通过路径 ====================

describe("runLimitGate 全通过路径", () => {
  it("四段全过：返回 allowed:true 并原样回传 halfOpenHeld=true", async () => {
    const { adapters, events } = makeMockAdapters({});
    const input = makeInput({ initialHalfOpenHeld: true });
    const result = await runLimitGate(input, adapters);

    expect(result).toEqual({ allowed: true, halfOpenHeld: true });
    // 检查顺序固定：pRpm → kRpm → pTpm → kTpm，且 est 统一下发给两段 TPM
    expect(events).toEqual([
      "check:pRpm",
      "check:kRpm",
      "check:pTpm:100",
      "check:kTpm:100",
    ]);
    // 全过无任何归还与钩子调用
    expect(adapters.releaseHalfOpenPending).not.toHaveBeenCalled();
    expect(adapters.releasePlatformRpm).not.toHaveBeenCalled();
    expect(adapters.releasePlatformTpm).not.toHaveBeenCalled();
    expect(input.onGateRejected).not.toHaveBeenCalled();
  });

  it("未持有半开槽位时通过：halfOpenHeld=false 回传", async () => {
    const { adapters } = makeMockAdapters({});
    const result = await runLimitGate(
      makeInput({ initialHalfOpenHeld: false }),
      adapters
    );

    expect(result).toEqual({ allowed: true, halfOpenHeld: false });
    expect(adapters.releaseHalfOpenPending).not.toHaveBeenCalled();
  });
});

// ==================== platformRpm 拒绝 ====================

describe("runLimitGate platformRpm 拒绝", () => {
  it("短路后续检查；仅条件释放槽位，无任何配额归还", async () => {
    const { adapters, events } = makeMockAdapters({ pRpm: denied() });
    const onGateRejected = vi.fn();
    const result = await runLimitGate(
      makeInput({ initialHalfOpenHeld: true, onGateRejected }),
      adapters
    );

    expect(result).toEqual({ allowed: false, stage: "platformRpm", resetAt: 1_000_060 });
    expect(events).toEqual(["check:pRpm", "release:slot"]);
    // check 拒绝分支自身未扣减计数，不归还任何配额
    expect(adapters.releasePlatformRpm).not.toHaveBeenCalled();
    expect(adapters.releasePlatformTpm).not.toHaveBeenCalled();
    expect(onGateRejected).toHaveBeenCalledTimes(1);
    expect(onGateRejected).toHaveBeenCalledWith(
      "platformRpm",
      expect.objectContaining({ allowed: false })
    );
  });

  it("未持有槽位时不释放（bug L5）", async () => {
    const { adapters, events } = makeMockAdapters({ pRpm: denied() });
    const result = await runLimitGate(
      makeInput({ initialHalfOpenHeld: false }),
      adapters
    );

    expect(result.allowed).toBe(false);
    expect(events).toEqual(["check:pRpm"]);
    expect(adapters.releaseHalfOpenPending).not.toHaveBeenCalled();
  });
});

// ==================== keyRpm 拒绝 ====================

describe("runLimitGate keyRpm 拒绝", () => {
  it("仅归还平台 RPM（用扣减时刻的 pRpm.windowStart）；TPM 检查被短路", async () => {
    const { adapters, events } = makeMockAdapters({
      kRpm: denied(),
      pRpm: ok(60_000),
    });
    const onGateRejected = vi.fn();
    const result = await runLimitGate(
      makeInput({ initialHalfOpenHeld: true, estimatedTokens: 200, onGateRejected }),
      adapters
    );

    expect(result).toEqual({ allowed: false, stage: "keyRpm", resetAt: 1_000_060 });
    // 顺序：pRpm → kRpm → 槽位 → RPM 归还；TPM 两段均未执行
    expect(events).toEqual([
      "check:pRpm",
      "check:kRpm",
      "release:slot",
      "release:rpm:60000",
    ]);
    expect(adapters.releasePlatformTpm).not.toHaveBeenCalled();
    expect(onGateRejected).toHaveBeenCalledWith("keyRpm", expect.any(Object));
  });

  it("未持有槽位时仅归还配额、不释放槽位", async () => {
    const { adapters, events } = makeMockAdapters({
      kRpm: denied(),
      pRpm: ok(120_000),
    });
    const result = await runLimitGate(
      makeInput({ initialHalfOpenHeld: false }),
      adapters
    );

    expect(result.allowed).toBe(false);
    expect(events).toEqual(["check:pRpm", "check:kRpm", "release:rpm:120000"]);
    expect(adapters.releaseHalfOpenPending).not.toHaveBeenCalled();
  });

  it("归还窗口键取 pRpm 的而非被拒 kRpm 的（跨窗口隔离）", async () => {
    const { adapters } = makeMockAdapters({
      pRpm: ok(60_000),
      kRpm: denied(180_000),
    });
    await runLimitGate(makeInput(), adapters);

    expect(adapters.releasePlatformRpm).toHaveBeenCalledTimes(1);
    expect(adapters.releasePlatformRpm).toHaveBeenCalledWith(60_000);
  });
});

// ==================== platformTpm 拒绝 ====================

describe("runLimitGate platformTpm 拒绝", () => {
  it("仅归还平台 RPM（TPM 计数在拒绝分支未写入，不可归还）；kTpm 被短路", async () => {
    const { adapters, events } = makeMockAdapters({
      pTpm: denied(65_000),
      pRpm: ok(60_000),
    });
    const onGateRejected = vi.fn();
    const result = await runLimitGate(
      makeInput({ initialHalfOpenHeld: true, estimatedTokens: 300, onGateRejected }),
      adapters
    );

    expect(result).toEqual({ allowed: false, stage: "platformTpm", resetAt: 1_000_060 });
    // 归还顺序与现有实现一致：槽位 → 平台 RPM；不归还 TPM（未扣减）
    expect(events).toEqual([
      "check:pRpm",
      "check:kRpm",
      "check:pTpm:300",
      "release:slot",
      "release:rpm:60000",
    ]);
    expect(adapters.releasePlatformTpm).not.toHaveBeenCalled();
    expect(onGateRejected).toHaveBeenCalledWith("platformTpm", expect.any(Object));
  });

  it("RPM 归还携带 pRpm.windowStart（扣减时刻窗口键）", async () => {
    const { adapters } = makeMockAdapters({
      pTpm: denied(70_000),
      pRpm: ok(60_000),
    });
    await runLimitGate(makeInput({ estimatedTokens: 500 }), adapters);

    expect(adapters.releasePlatformRpm).toHaveBeenCalledTimes(1);
    expect(adapters.releasePlatformRpm).toHaveBeenCalledWith(60_000);
  });
});

// ==================== keyTpm 拒绝 ====================

describe("runLimitGate keyTpm 拒绝", () => {
  it("归还平台 RPM+TPM；窗口键均为扣减时刻的平台级值，不用被拒 kTpm 的", async () => {
    const { adapters, events } = makeMockAdapters({
      kTpm: denied(190_000),
      pRpm: ok(60_000),
      pTpm: ok(65_000),
    });
    const onGateRejected = vi.fn();
    const result = await runLimitGate(
      makeInput({ initialHalfOpenHeld: true, estimatedTokens: 128, onGateRejected }),
      adapters
    );

    expect(result).toEqual({ allowed: false, stage: "keyTpm", resetAt: 1_000_060 });
    expect(events).toEqual([
      "check:pRpm",
      "check:kRpm",
      "check:pTpm:128",
      "check:kTpm:128",
      "release:slot",
      "release:rpm:60000",
      "release:tpm:128:65000",
    ]);
    // 关键断言：绝不误用被拒 Key 级结果的窗口键 190000
    expect(adapters.releasePlatformRpm).toHaveBeenCalledWith(60_000);
    expect(adapters.releasePlatformTpm).toHaveBeenCalledWith(128, 65_000);
    expect(onGateRejected).toHaveBeenCalledWith("keyTpm", expect.any(Object));
  });

  it("未持有槽位时不释放，仅归还两项配额", async () => {
    const { adapters, events } = makeMockAdapters({
      kTpm: denied(),
      pRpm: ok(60_000),
      pTpm: ok(65_000),
    });
    const result = await runLimitGate(
      makeInput({ initialHalfOpenHeld: false }),
      adapters
    );

    expect(result.allowed).toBe(false);
    expect(events).toEqual([
      "check:pRpm",
      "check:kRpm",
      "check:pTpm:100",
      "check:kTpm:100",
      "release:rpm:60000",
      "release:tpm:100:65000",
    ]);
    expect(adapters.releaseHalfOpenPending).not.toHaveBeenCalled();
  });
});

// ==================== 尽力而为：release 抛错 ====================

describe("runLimitGate release 抛错不影响结果", () => {
  it("kTpm 拒绝且全部 release 抛错：仍正常返回拒绝结果并触发钩子", async () => {
    const { adapters, events } = makeMockAdapters({
      kTpm: denied(),
      pRpm: ok(60_000),
      pTpm: ok(65_000),
      failReleases: true,
    });
    const onGateRejected = vi.fn();
    const result = await runLimitGate(
      makeInput({ initialHalfOpenHeld: true, onGateRejected }),
      adapters
    );

    expect(result).toEqual({ allowed: false, stage: "keyTpm", resetAt: 1_000_060 });
    // 三次归还调用都发生了（只是失败被吞掉），钩子照常触发
    expect(events.slice(-3)).toEqual([
      "release:slot",
      "release:rpm:60000",
      "release:tpm:100:65000",
    ]);
    expect(onGateRejected).toHaveBeenCalledTimes(1);
  });

  it("platformRpm 拒绝且槽位释放抛错：仍正常返回拒绝结果", async () => {
    const { adapters } = makeMockAdapters({ pRpm: denied(), failReleases: true });
    const result = await runLimitGate(makeInput(), adapters);

    expect(result).toEqual({ allowed: false, stage: "platformRpm", resetAt: 1_000_060 });
  });
});

// ==================== lite 空适配器组合 ====================

describe("lite 空适配器组合", () => {
  /** lite 端形态：无限流段、无熔断器 —— 恒 allowed 且无副作用 */
  function noopAdapters(): LimitGateAdapters {
    return {
      // 包 vi.fn() 以便断言全程零调用
      checkPlatformRpm: vi.fn(async () => ({ allowed: true })),
      checkApiKeyRpm: vi.fn(async () => ({ allowed: true })),
      checkPlatformTpm: vi.fn(async () => ({ allowed: true })),
      checkApiKeyTpm: vi.fn(async () => ({ allowed: true })),
      releasePlatformRpm: vi.fn(async () => {}),
      releasePlatformTpm: vi.fn(async () => {}),
      releaseHalfOpenPending: vi.fn(() => {}),
    };
  }

  it("恒放行且无任何副作用，结果为 allowed:true + halfOpenHeld:false", async () => {
    const adapters = noopAdapters();
    const onGateRejected = vi.fn();
    const result = await runLimitGate(
      makeInput({ initialHalfOpenHeld: false, onGateRejected }),
      adapters
    );

    expect(result).toEqual({ allowed: true, halfOpenHeld: false });
    expect(adapters.releasePlatformRpm).not.toHaveBeenCalled();
    expect(adapters.releasePlatformTpm).not.toHaveBeenCalled();
    expect(adapters.releaseHalfOpenPending).not.toHaveBeenCalled();
    expect(onGateRejected).not.toHaveBeenCalled();
  });
});
