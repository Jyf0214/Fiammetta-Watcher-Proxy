/**
 * 管理 API 全局速率限制（src/lib/admin-rate-limit.ts）— 内存路径测试
 *
 * 覆盖非 Cloudflare 平台（EdgeOne / Vercel / 纯 Node）的进程内滑动窗口兜底分支：
 * - 首次请求放行
 * - 100 次内放行，第 101 次 429 + Retry-After + resetAt
 * - 60 秒窗口滑动后计数重置
 * - 不同管理员独立计数
 *
 * @opennextjs/cloudflare 被 mock 为 getCloudflareContext 抛错（模拟非 Cloudflare 平台
 * 无 Cloudflare 上下文的形态），checkAdminRateLimit 内部动态 import 后 kv 为
 * undefined，自动落入 checkMemoryWindow 进程内窗口。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextApiResponse } from "next";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no Cloudflare context (non-Cloudflare platform)");
  },
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkAdminRateLimit — 内存路径（非 Cloudflare 平台兜底）", () => {
  it("首次请求放行，不发送 429", async () => {
    const res = makeRes();
    await expect(checkAdminRateLimit("mem-admin-1", res)).resolves.toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("100 次内放行，第 101 次返回 false + 429 + Retry-After + resetAt", async () => {
    for (let i = 0; i < 100; i++) {
      const res = makeRes();
      await expect(checkAdminRateLimit("mem-admin-2", res)).resolves.toBe(true);
      expect(res.statusCode).toBe(200);
    }

    const res101 = makeRes();
    await expect(checkAdminRateLimit("mem-admin-2", res101)).resolves.toBe(false);
    expect(res101.statusCode).toBe(429);
    expect(res101.body).toMatchObject({
      success: false,
      error: "管理 API 请求过于频繁（100 次/分钟），请稍后再试",
    });
    // 首次调用时间 + 窗口长度（fake timers 静止，now 固定）
    expect(res101.headers["Retry-After"]).toBe("60");
    expect((res101.body as { resetAt: string }).resetAt).toBe(
      new Date(FIXED_NOW.getTime() + 60_000).toISOString()
    );
  });

  it("60 秒窗口滑动后计数重置（旧计数过期放行）", async () => {
    for (let i = 0; i < 100; i++) {
      const res = makeRes();
      await expect(checkAdminRateLimit("mem-admin-3", res)).resolves.toBe(true);
    }

    // 推进 61 秒（整个窗口滑出）
    vi.setSystemTime(new Date(FIXED_NOW.getTime() + 61_000));

    const res = makeRes();
    await expect(checkAdminRateLimit("mem-admin-3", res)).resolves.toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("不同管理员独立计数（互不牵连）", async () => {
    for (let i = 0; i < 100; i++) {
      const res = makeRes();
      await expect(checkAdminRateLimit("mem-admin-a", res)).resolves.toBe(true);
    }
    // A 已超限，B 仍放行
    const resA = makeRes();
    await expect(checkAdminRateLimit("mem-admin-a", resA)).resolves.toBe(false);

    const resB = makeRes();
    await expect(checkAdminRateLimit("mem-admin-b", resB)).resolves.toBe(true);
    expect(resB.statusCode).toBe(200);
  });
});
