/**
 * recordRequestLog proxyUrl 透传测试
 *
 * 验证 request_logs.proxy_url 列写入：传 proxyUrl 时原样落库（可用性监控
 * 数据源）；未传 / 显式 undefined 时写 null（直连与其他部署形态兼容，
 * Worker 侧 proxy.ts 调用方不传该参数不受影响）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

describe("recordRequestLog proxyUrl 透传", () => {
  const baseParams = {
    keyId: null,
    keyName: null,
    platformId: null,
    model: "gpt-4o",
    endpoint: "/v1/chat/completions",
    method: "POST",
    status: 200,
    tokens: 10,
    promptTokens: 5,
    completionTokens: 5,
    ttft: 0,
    duration: 100,
    isError: false,
    db: {} as D1Database,
    env: { DB_TYPE: "pg" } as { DB_TYPE: string },
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("传 proxyUrl → 原样写入 request_logs.proxy_url", async () => {
    const { createDb } = await import("@/lib/prisma");
    const mockCreate = vi.fn(async (_args: any) => ({}));
    vi.mocked(createDb).mockResolvedValue({
      requestLogs: { create: mockCreate },
    } as any);

    const { recordRequestLog } = await import("../token");
    await recordRequestLog({ ...baseParams, proxyUrl: "http://127.0.0.1:7890" });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.proxyUrl).toBe("http://127.0.0.1:7890");
  });

  it("不传 proxyUrl → 写入 null（直连请求/非 Docker 部署兼容）", async () => {
    const { createDb } = await import("@/lib/prisma");
    const mockCreate = vi.fn(async (_args: any) => ({}));
    vi.mocked(createDb).mockResolvedValue({
      requestLogs: { create: mockCreate },
    } as any);

    const { recordRequestLog } = await import("../token");
    await recordRequestLog(baseParams);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.proxyUrl).toBeNull();
  });

  it("显式传 undefined → 写入 null", async () => {
    const { createDb } = await import("@/lib/prisma");
    const mockCreate = vi.fn(async (_args: any) => ({}));
    vi.mocked(createDb).mockResolvedValue({
      requestLogs: { create: mockCreate },
    } as any);

    const { recordRequestLog } = await import("../token");
    await recordRequestLog({ ...baseParams, proxyUrl: undefined });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.proxyUrl).toBeNull();
  });

  it("含 user:pass 凭据的 proxyUrl → 落库为脱敏地址（凭据不进日志表/统计）", async () => {
    const { createDb } = await import("@/lib/prisma");
    const mockCreate = vi.fn(async (_args: any) => ({}));
    vi.mocked(createDb).mockResolvedValue({
      requestLogs: { create: mockCreate },
    } as any);

    const { recordRequestLog } = await import("../token");
    await recordRequestLog({ ...baseParams, proxyUrl: "socks5://user:pass@127.0.0.1:1080" });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.proxyUrl).toBe("socks5://***@127.0.0.1:1080");
  });
});
