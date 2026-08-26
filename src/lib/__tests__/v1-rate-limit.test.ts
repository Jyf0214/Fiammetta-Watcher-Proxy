/**
 * v1-rate-limit.ts 内存速率限制器单元测试
 *
 * 覆盖：
 * - checkPlatformRpm / checkPlatformTpm / checkApiKeyRpm / checkApiKeyTpm
 * - null 限制不拦截
 * - TPM 恰好打满配额（c + est === tpmLimit）时拒绝——与 KV 版（worker/src/rate-limiter.ts）的 >= 语义一致
 * - RPM 每窗口最多放行 rpmLimit 个请求
 * - windowStart 返回（与扣减窗口键同源，放行/拒绝均携带；limit=null 早退不带）
 *
 * 注意：模块内部计数器为模块级 Map（跨测试共享），每个用例使用唯一 id 避免相互污染。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkPlatformRpm,
  checkPlatformTpm,
  checkApiKeyRpm,
  checkApiKeyTpm,
  releasePlatformRpm,
} from "@/lib/v1-rate-limit";

let seq = 0;
function uid(): string {
  seq += 1;
  return `t${seq}-${Date.now()}`;
}

// ==================== checkPlatformTpm ====================

describe("checkPlatformTpm（内存版）", () => {
  it("tpmLimit=null 时不限制", async () => {
    const result = await checkPlatformTpm("p-null-" + uid(), null, 100);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("token 累加未超限允许", async () => {
    const id = uid();
    await checkPlatformTpm(id, 1000, 400);
    const result = await checkPlatformTpm(id, 1000, 400);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(200);
  });

  it("恰好打满配额（c + est === tpmLimit）时拒绝——与 KV 版 >= 语义一致", async () => {
    const id = uid();
    const r1 = await checkPlatformTpm(id, 1000, 600);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(400);
    // 第二次请求 est=400：600+400 === 1000，按 >= 语义必须拒绝
    const r2 = await checkPlatformTpm(id, 1000, 400);
    expect(r2.allowed).toBe(false);
    expect(r2.remaining).toBe(0);
  });

  it("超限（c + est > tpmLimit）拒绝", async () => {
    const id = uid();
    await checkPlatformTpm(id, 1000, 800);
    const result = await checkPlatformTpm(id, 1000, 300); // 800+300=1100 > 1000
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

// ==================== checkApiKeyTpm ====================

describe("checkApiKeyTpm（内存版）", () => {
  it("tpmLimit=null 时不限制", async () => {
    const result = await checkApiKeyTpm("k-null-" + uid(), null, 100);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(Infinity);
  });

  it("恰好打满配额（c + est === tpmLimit）时拒绝——与 KV 版 >= 语义一致", async () => {
    const id = uid();
    const r1 = await checkApiKeyTpm(id, 500, 300);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(200);
    // 第二次请求 est=200：300+200 === 500，按 >= 语义必须拒绝
    const r2 = await checkApiKeyTpm(id, 500, 200);
    expect(r2.allowed).toBe(false);
    expect(r2.remaining).toBe(0);
  });

  it("不同 key 独立计数", async () => {
    await checkApiKeyTpm("k-a-" + uid(), 500, 400);
    const result = await checkApiKeyTpm("k-b-" + uid(), 500, 400);
    expect(result.allowed).toBe(true);
  });
});

// ==================== RPM 边界（与 KV 版一致：>= 拒绝） ====================

describe("checkPlatformRpm / checkApiKeyRpm（内存版）", () => {
  it("平台 RPM 恰好打满时拒绝", async () => {
    const id = uid();
    await checkPlatformRpm(id, 3);
    await checkPlatformRpm(id, 3);
    const r3 = await checkPlatformRpm(id, 3); // count 2→3，恰好打满
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
    const r4 = await checkPlatformRpm(id, 3); // count=3 >= 3 → 拒绝
    expect(r4.allowed).toBe(false);
  });

  it("平台 RPM limit=1 时首个允许第二个拒绝", async () => {
    const id = uid();
    const r1 = await checkPlatformRpm(id, 1);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(0);
    const r2 = await checkPlatformRpm(id, 1);
    expect(r2.allowed).toBe(false);
  });

  it("Key RPM 恰好打满时拒绝", async () => {
    const id = uid();
    await checkApiKeyRpm(id, 2);
    const r2 = await checkApiKeyRpm(id, 2);
    expect(r2.allowed).toBe(true);
    const r3 = await checkApiKeyRpm(id, 2); // count=2 >= 2 → 拒绝
    expect(r3.allowed).toBe(false);
  });
});

// ==================== windowStart 返回（双端对称：放行/拒绝均携带） ====================

describe("check* 返回 windowStart（与窗口键同源）", () => {
  const WINDOW_MS = 60_000;
  // 固定 mock 时刻，保证窗口起点确定：ws = floor(T / WINDOW_MS) * WINDOW_MS
  const T = 1_700_000_059_500;
  const ws = Math.floor(T / WINDOW_MS) * WINDOW_MS;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(T);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checkPlatformRpm 放行/拒绝分支均返回窗口键起点", async () => {
    const id = uid();
    const r1 = await checkPlatformRpm(id, 2);
    expect(r1.allowed).toBe(true);
    expect(r1.windowStart).toBe(ws);
    expect(r1.resetAt).toBe(ws + WINDOW_MS);

    await checkPlatformRpm(id, 2); // count→2 占满
    const r3 = await checkPlatformRpm(id, 2); // count=2 >= 2 → 拒绝
    expect(r3.allowed).toBe(false);
    expect(r3.windowStart).toBe(ws);
    expect(r3.resetAt).toBe(ws + WINDOW_MS);
  });

  it("checkPlatformTpm 放行/拒绝分支均返回窗口键起点", async () => {
    const id = uid();
    const r1 = await checkPlatformTpm(id, 1000, 600);
    expect(r1.allowed).toBe(true);
    expect(r1.windowStart).toBe(ws);

    const r2 = await checkPlatformTpm(id, 1000, 500); // 600+500=1100 >= 1000 → 拒绝
    expect(r2.allowed).toBe(false);
    expect(r2.windowStart).toBe(ws);
  });

  it("checkApiKeyRpm 放行/拒绝分支均返回窗口键起点", async () => {
    const id = uid();
    const r1 = await checkApiKeyRpm(id, 5);
    expect(r1.allowed).toBe(true);
    expect(r1.windowStart).toBe(ws);

    for (let i = 0; i < 4; i++) await checkApiKeyRpm(id, 5); // count→5 占满
    const r7 = await checkApiKeyRpm(id, 5); // count=5 >= 5 → 拒绝
    expect(r7.allowed).toBe(false);
    expect(r7.windowStart).toBe(ws);
  });

  it("checkApiKeyTpm 放行/拒绝分支均返回窗口键起点", async () => {
    const id = uid();
    const r1 = await checkApiKeyTpm(id, 800, 500);
    expect(r1.allowed).toBe(true);
    expect(r1.windowStart).toBe(ws);

    const r2 = await checkApiKeyTpm(id, 800, 300); // 500+300=800 >= 800 → 拒绝
    expect(r2.allowed).toBe(false);
    expect(r2.windowStart).toBe(ws);
  });

  it("未触发窗口计数时不返回 windowStart（limit=null 早退）", async () => {
    expect((await checkPlatformRpm("p-null-" + uid(), null)).windowStart).toBeUndefined();
    expect((await checkPlatformTpm("p-null-" + uid(), null, 100)).windowStart).toBeUndefined();
    expect((await checkApiKeyRpm("k-null-" + uid(), null)).windowStart).toBeUndefined();
    expect((await checkApiKeyTpm("k-null-" + uid(), null, 100)).windowStart).toBeUndefined();
  });

  it("windowStart 与扣减窗口桶同源：按其回滚后配额恢复", async () => {
    const id = uid();
    const r1 = await checkPlatformRpm(id, 1);
    expect(r1.allowed).toBe(true);
    const r2 = await checkPlatformRpm(id, 1); // count=1 >= 1 → 拒绝
    expect(r2.allowed).toBe(false);
    // 按 r2.windowStart（= 扣减窗口键）回滚 → 计数归零 → 再次放行；
    // 若 windowStart 与扣减桶不同源则回滚 no-op，r3 必然仍被拒绝
    await releasePlatformRpm(id, 1, r2.windowStart);
    const r3 = await checkPlatformRpm(id, 1);
    expect(r3.allowed).toBe(true);
  });
});