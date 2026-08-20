/**
 * recordRequestLog proxyUrl 透传测试
 *
 * 验证 request_logs.proxy_url 列写入：传 proxyUrl 时转为代理级统计键落库
 * （无凭据地址为 host:port；带凭据地址为 host:port#<账号指纹>，同 host:port
 * 不同账号独立成键，不再合并）；未传 / 显式 undefined 时写 null（直连与其他
 * 部署形态兼容，Worker 侧 proxy.ts 调用方不传该参数不受影响）
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

  it("传 proxyUrl → 归一化为去凭据 host:port 统计键写入 request_logs.proxy_url", async () => {
    const { createDb } = await import("@/lib/prisma");
    const mockCreate = vi.fn(async (_args: any) => ({}));
    vi.mocked(createDb).mockResolvedValue({
      requestLogs: { create: mockCreate },
    } as any);

    const { recordRequestLog } = await import("../token");
    await recordRequestLog({ ...baseParams, proxyUrl: "http://127.0.0.1:7890" });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.proxyUrl).toBe("127.0.0.1:7890");
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

  it("含 user:pass 凭据的 proxyUrl → 落库为账号级统计键（host:port#指纹，凭据不进日志表）", async () => {
    const { createDb } = await import("@/lib/prisma");
    const mockCreate = vi.fn(async (_args: any) => ({}));
    vi.mocked(createDb).mockResolvedValue({
      requestLogs: { create: mockCreate },
    } as any);

    const { recordRequestLog } = await import("../token");
    await recordRequestLog({ ...baseParams, proxyUrl: "socks5://user:pass@127.0.0.1:1080" });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    // 指纹为 FNV-1a 哈希：不含凭据明文且稳定可复现
    expect(mockCreate.mock.calls[0][0].data.proxyUrl).toBe("127.0.0.1:1080#0bd4d3a5");
  });

  it("同 host:port 不同账号（user:pass）→ 落库为不同统计键，不再合并", async () => {
    const { createDb } = await import("@/lib/prisma");
    const mockCreate = vi.fn(async (_args: any) => ({}));
    vi.mocked(createDb).mockResolvedValue({
      requestLogs: { create: mockCreate },
    } as any);

    const { recordRequestLog } = await import("../token");
    await recordRequestLog({ ...baseParams, proxyUrl: "http://user1:pass1@proxy.example.com:8080" });
    await recordRequestLog({ ...baseParams, proxyUrl: "http://user2:pass2@proxy.example.com:8080" });

    expect(mockCreate).toHaveBeenCalledTimes(2);
    const first = mockCreate.mock.calls[0][0].data.proxyUrl;
    const second = mockCreate.mock.calls[1][0].data.proxyUrl;
    // 同 host:port 但账号不同 → 键不同（此前归一化为同一键 host:port，统计互相污染）
    expect(first).toBe("proxy.example.com:8080#87c99c34");
    expect(second).toBe("proxy.example.com:8080#e24df5b4");
    expect(first).not.toBe(second);
  });
});
