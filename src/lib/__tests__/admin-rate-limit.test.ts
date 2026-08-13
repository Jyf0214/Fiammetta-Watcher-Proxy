/**
 * 管理 API 全局速率限制（src/lib/admin-rate-limit.ts）— KV 路径测试
 *
 * 覆盖 checkAdminRateLimit 的 Cloudflare KV 滑动窗口分支：
 * - 正常计数：首次请求写入 KV、窗口内多次请求累积
 * - 超限 429：Retry-After + resetAt + 不再写入
 * - 窗口滑动：60 秒外旧计数过期放行
 * - KV 异常降级：get/put 抛错时降级进程内内存窗口（不 fail-open 成无限流）
 *
 * @opennextjs/cloudflare 被 mock 为提供可控内存 KV（get/put/delete + 可注入异常），
 * 不依赖真实 CF 运行时。内存路径（非 CF 平台）见 admin-rate-limit-memory.test.ts。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiResponse } from "next";

// vi.hoisted：mock 工厂引用同一批 vi.fn，测试中可注入异常/断言调用
const { kvStore, kvGet, kvPut, kvDelete } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    kvStore: store,
    kvGet: vi.fn(async (key: string) => store.get(key) ?? null),
    kvPut: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    kvDelete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
});

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: { KV: { get: kvGet, put: kvPut, delete: kvDelete } },
  }),
}));

import { checkAdminRateLimit } from "../admin-rate-limit";

const FIXED_NOW = new Date("2026-08-12T00:00:00.000Z");

interface ResLike {
  headers: Record<string, string>;
  statusCode: number;
  body: unknown;
}

function makeRes(): ResLike & NextApiResponse {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  const res: any = {
    headers,
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
      return res;
    },
    getHeader(k: string) {
      return headers[k];
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
  return res as ResLike & NextApiResponse;
}

/** 预填 KV 记录（绕过 put mock 计数，直接落 store） */
function seedKv(adminId: string, timestamps: number[]): void {
  kvStore.set(`admin:ratelimit:${adminId}`, JSON.stringify({ timestamps }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  kvStore.clear();
  kvGet.mockClear();
  kvPut.mockClear();
  kvDelete.mockClear();
  kvGet.mockImplementation(async (key: string) => kvStore.get(key) ?? null);
  kvPut.mockImplementation(async (key: string, value: string) => {
    kvStore.set(key, value);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkAdminRateLimit — KV 路径：正常计数", () => {
  it("首次请求放行并写入 KV 记录（窗口内 1 条时间戳）", async () => {
    const res = makeRes();
    await expect(checkAdminRateLimit("kv-admin-1", res)).resolves.toBe(true);

    expect(kvPut).toHaveBeenCalledTimes(1);
    expect(kvPut).toHaveBeenCalledWith(
      "admin:ratelimit:kv-admin-1",
      JSON.stringify({ timestamps: [FIXED_NOW.getTime()] }),
      { expirationTtl: 70 }
    );
    expect(res.statusCode).toBe(200);
  });

  it("窗口内多次请求累积计数（每次追加当前时间戳）", async () => {
    const res = makeRes();
    for (let i = 0; i < 3; i++) {
      await expect(checkAdminRateLimit("kv-admin-2", res)).resolves.toBe(true);
    }
    const raw = kvStore.get("admin:ratelimit:kv-admin-2")!;
    const record = JSON.parse(raw) as { timestamps: number[] };
    expect(record.timestamps).toHaveLength(3);
    expect(record.timestamps.every((ts) => ts === FIXED_NOW.getTime())).toBe(true);
  });

  it("窗口滑动：60 秒外旧计数不参与（过期后放行并重建窗口）", async () => {
    const oldTs = Array.from({ length: 100 }, (_, i) => FIXED_NOW.getTime() - 61_000 - i * 1000);
    seedKv("kv-admin-3", oldTs);

    const res = makeRes();
    await expect(checkAdminRateLimit("kv-admin-3", res)).resolves.toBe(true);
    expect(res.statusCode).toBe(200);

    // 重建后的窗口只剩本次请求
    const record = JSON.parse(kvStore.get("admin:ratelimit:kv-admin-3")!) as {
      timestamps: number[];
    };
    expect(record.timestamps).toEqual([FIXED_NOW.getTime()]);
  });
});

describe("checkAdminRateLimit — KV 路径：超限 429", () => {
  it("窗口内满 100 次后返回 false + 429 + Retry-After + resetAt（不再写入）", async () => {
    // 预填 100 条窗口内时间戳（全部 > now - 60s）
    const timestamps = Array.from({ length: 100 }, (_, i) => FIXED_NOW.getTime() - i * 500);
    seedKv("kv-admin-limit", timestamps);

    kvPut.mockClear(); // 预填不算 put 调用
    const res = makeRes();
    await expect(checkAdminRateLimit("kv-admin-limit", res)).resolves.toBe(false);

    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      success: false,
      error: "管理 API 请求过于频繁（100 次/分钟），请稍后再试",
      resetAt: new Date(timestamps[0] + 60_000).toISOString(),
    });
    // resetAt = 最早一条 + 窗口长度；Retry-After 秒级向上取整
    expect(res.headers["Retry-After"]).toBe("60");
    // 超限时只读不写
    expect(kvPut).not.toHaveBeenCalled();
  });
});

describe("checkAdminRateLimit — KV 路径：异常降级", () => {
  it("KV get 抛错时降级内存窗口（放行并计数，不 fail-open 成无限流）", async () => {
    kvGet.mockRejectedValueOnce(new Error("kv unavailable"));

    const res = makeRes();
    await expect(checkAdminRateLimit("kv-failover-1", res)).resolves.toBe(true);
    expect(res.statusCode).toBe(200);

    // 降级后内存窗口已计数：第二次（KV 正常）仍放行
    const res2 = makeRes();
    await expect(checkAdminRateLimit("kv-failover-1", res2)).resolves.toBe(true);
    expect(res2.statusCode).toBe(200);
  });

  it("KV put 抛错时降级内存窗口（放行）", async () => {
    kvPut.mockRejectedValueOnce(new Error("kv write failed"));

    const res = makeRes();
    await expect(checkAdminRateLimit("kv-failover-2", res)).resolves.toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("KV 持续异常时内存窗口兜底：100 次内放行，第 101 次 429", async () => {
    kvGet.mockRejectedValue(new Error("kv down"));

    for (let i = 0; i < 100; i++) {
      const res = makeRes();
      await expect(checkAdminRateLimit("kv-failover-3", res)).resolves.toBe(true);
    }

    const res101 = makeRes();
    await expect(checkAdminRateLimit("kv-failover-3", res101)).resolves.toBe(false);
    expect(res101.statusCode).toBe(429);
    expect(res101.body).toMatchObject({ success: false });
    expect(typeof res101.headers["Retry-After"]).toBe("string");
    expect((res101.body as { resetAt: string }).resetAt).toBeDefined();
  });
});
