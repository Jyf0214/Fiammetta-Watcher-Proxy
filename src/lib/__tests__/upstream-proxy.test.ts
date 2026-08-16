/**
 * upstream-proxy.ts 出站代理测试
 *
 * 覆盖：
 * - 非 Docker 部署（DEPLOY_PLATFORM≠docker）不启用，且不查询数据库
 * - Docker 部署 + 无配置 / 空配置 → null（直连）
 * - Docker + http/https 代理 URL → 返回 undici ProxyAgent
 * - 非 http(s) 协议（socks://）→ 视为未配置返回 null
 * - 缓存：TTL 内复用；configs.updatedAt 变化强制重载
 * - 配置清空后恢复直连（释放旧代理）
 *
 * 模块级缓存跨测试共享，每个用例用 vi.resetModules + 动态 import 取新模块实例
 * （与 request-templates.test.ts 的模式一致）
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Dispatcher } from "undici";

const mockFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    configs: { findFirst: mockFindFirst },
  })),
}));

const mockDb = {} as D1Database;
const mockEnv = { DB_TYPE: "pg" } as any;

let originalPlatform: string | undefined;
let originalDbType: string | undefined;

function setPlatform(value: string | undefined) {
  if (value === undefined) delete process.env.DEPLOY_PLATFORM;
  else process.env.DEPLOY_PLATFORM = value;
}

function configRow(value: string | null, updatedAt = 1000) {
  return value === null ? null : { value, updatedAt };
}

async function loadModule() {
  const mod = await import("../upstream-proxy");
  return mod.getUpstreamProxyDispatcher;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  originalPlatform = process.env.DEPLOY_PLATFORM;
  originalDbType = process.env.DB_TYPE;
  setPlatform("docker");
});

afterEach(() => {
  setPlatform(originalPlatform);
  if (originalDbType === undefined) delete process.env.DB_TYPE;
  else process.env.DB_TYPE = originalDbType;
});

describe("部署平台门控", () => {
  it("非 docker 部署（未设置）直接返回 null，不查询数据库", async () => {
    setPlatform(undefined);
    const getDispatcher = await loadModule();
    mockFindFirst.mockResolvedValue(configRow("http://127.0.0.1:7890"));

    const result = await getDispatcher(mockDb, mockEnv);

    expect(result).toBeNull();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("非 docker 部署（edgeone/cf/vercel）同样不启用", async () => {
    for (const platform of ["edgeone", "cf", "vercel"]) {
      vi.resetModules();
      setPlatform(platform);
      const getDispatcher = await loadModule();
      const result = await getDispatcher(mockDb, mockEnv);
      expect(result).toBeNull();
    }
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

describe("配置读取与代理创建", () => {
  it("无配置记录 → null（直连）", async () => {
    const getDispatcher = await loadModule();
    mockFindFirst.mockResolvedValue(null);

    const result = await getDispatcher(mockDb, mockEnv);

    expect(result).toBeNull();
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: "system:upstream_proxy" } })
    );
  });

  it("配置为空字符串/纯空白 → null（直连）", async () => {
    const getDispatcher = await loadModule();
    mockFindFirst.mockResolvedValue(configRow("   "));

    const result = await getDispatcher(mockDb, mockEnv);

    expect(result).toBeNull();
  });

  it("http 代理 URL → 返回 undici ProxyAgent", async () => {
    const getDispatcher = await loadModule();
    mockFindFirst.mockResolvedValue(configRow("http://127.0.0.1:7890"));

    const agent = await getDispatcher(mockDb, mockEnv);

    expect(agent).not.toBeNull();
    // undici ProxyAgent 实例特征：具有 dispatch/close 方法
    expect(typeof (agent as Dispatcher).dispatch).toBe("function");
    expect(typeof (agent as Dispatcher).close).toBe("function");
  });

  it("https 代理 URL → 返回 ProxyAgent", async () => {
    const getDispatcher = await loadModule();
    mockFindFirst.mockResolvedValue(configRow("https://proxy.example.com:8443"));

    const agent = await getDispatcher(mockDb, mockEnv);

    expect(agent).not.toBeNull();
  });

  it("不支持的协议（socks5://）→ null 且不抛错", async () => {
    const getDispatcher = await loadModule();
    mockFindFirst.mockResolvedValue(configRow("socks5://127.0.0.1:1080"));

    const agent = await getDispatcher(mockDb, mockEnv);

    expect(agent).toBeNull();
  });
});

describe("缓存与更新", () => {
  it("TTL 内重复调用复用缓存（仅一次全量读取 + 失效检查）", async () => {
    const getDispatcher = await loadModule();
    mockFindFirst.mockResolvedValue(configRow("http://127.0.0.1:7890"));

    await getDispatcher(mockDb, mockEnv);
    await getDispatcher(mockDb, mockEnv);

    // 第一次全量读取 + 第二次失效检查（select 只含 updatedAt）
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
    expect(mockFindFirst.mock.calls[0][0].select).toHaveProperty("value");
    expect(mockFindFirst.mock.calls[1][0].select).not.toHaveProperty("value");
  });

  it("updatedAt 变化 → 强制重载新代理地址", async () => {
    const getDispatcher = await loadModule();
    mockFindFirst.mockResolvedValue(configRow("http://127.0.0.1:7890", 1000));
    await getDispatcher(mockDb, mockEnv);

    // 管理后台保存：值变化 + updatedAt 变化
    mockFindFirst.mockResolvedValue(configRow("http://127.0.0.1:7891", 2000));
    const agent2 = await getDispatcher(mockDb, mockEnv);

    expect(agent2).not.toBeNull();
  });

  it("配置从有到无（清空保存）→ 恢复直连返回 null", async () => {
    const getDispatcher = await loadModule();
    mockFindFirst.mockResolvedValue(configRow("http://127.0.0.1:7890", 1000));
    await getDispatcher(mockDb, mockEnv);

    // 清空配置 + updatedAt 变化
    mockFindFirst.mockResolvedValue(configRow("", 2000));
    const result = await getDispatcher(mockDb, mockEnv);

    expect(result).toBeNull();
  });

  it("数据库读取失败 → 返回 null 不抛错", async () => {
    const getDispatcher = await loadModule();
    mockFindFirst.mockRejectedValue(new Error("db down"));

    const result = await getDispatcher(mockDb, mockEnv);

    expect(result).toBeNull();
  });
});