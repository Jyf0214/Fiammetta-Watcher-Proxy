/**
 * upstream-proxy.ts 出站代理测试
 *
 * 覆盖：
 * - 非 Docker 部署（DEPLOY_PLATFORM≠docker）不启用，且不查询数据库
 * - 配置解析：旧版纯 URL 字符串 / JSON（urls + platformIds + healthCheckUrl）
 * - 平台白名单：空列表=全部平台；非空时仅勾选平台走代理
 * - 多代理 round-robin 轮询（交替选择，health fail / 连续失败跳过）
 * - markProxyFailure：网络层失败达阈值后写入健康表并跳过轮询
 * - runProxyHealthCheck：探测结果写入健康表（cron 与管理页共用）
 * - 缓存：TTL 内复用；configs.updatedAt 变化强制重载
 *
 * 模块级缓存跨测试共享，每个用例用 vi.resetModules + 动态 import 取新模块实例
 * （与 request-templates.test.ts 的模式一致）
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Dispatcher } from "undici";

const mockFindFirst = vi.fn();
const mockUpsert = vi.fn(async (_args: any) => ({}));
vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    configs: { findFirst: mockFindFirst, upsert: mockUpsert },
  })),
}));

// mock undici：捕获创建的 ProxyAgent 实例列表，用于断言池化复用与
// 配置变化时旧实例被 close 释放（真实 ProxyAgent 无外部句柄无法断言）
const { createdAgents } = vi.hoisted(() => ({ createdAgents: [] as any[] }));
vi.mock("undici", () => ({
  ProxyAgent: class MockProxyAgent {
    url: string;
    close = vi.fn(async () => {});
    dispatch() {}
    constructor(url: string) {
      this.url = url;
      createdAgents.push(this);
    }
  },
}));

const mockDb = {} as D1Database;
const mockEnv = { DB_TYPE: "pg" } as any;
const CONFIG_KEY = "system:upstream_proxy";
const HEALTH_KEY = "system:upstream_proxy_health";

let originalPlatform: string | undefined;
let originalDbType: string | undefined;

function setPlatform(value: string | undefined) {
  if (value === undefined) delete process.env.DEPLOY_PLATFORM;
  else process.env.DEPLOY_PLATFORM = value;
}

/** 按查询 key 返回配置行（失效检查与全量读取共用同一 mock 实现） */
function setConfigRows(rows: Record<string, { value: string; updatedAt: number } | null>) {
  mockFindFirst.mockImplementation((args: any) => {
    const key: string | undefined = args?.where?.key;
    const row = key !== undefined && key in rows ? rows[key] : null;
    return Promise.resolve(row ? { value: row.value, updatedAt: row.updatedAt } : null);
  });
}

async function loadModule() {
  return import("../upstream-proxy");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  createdAgents.length = 0;
  originalPlatform = process.env.DEPLOY_PLATFORM;
  originalDbType = process.env.DB_TYPE;
  setPlatform("docker");
});

afterEach(() => {
  setPlatform(originalPlatform);
  if (originalDbType === undefined) delete process.env.DB_TYPE;
  else process.env.DB_TYPE = originalDbType;
  vi.unstubAllGlobals();
});

describe("部署平台门控", () => {
  it("非 docker 部署（未设置）直接返回 null，不查询数据库", async () => {
    setPlatform(undefined);
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({ [CONFIG_KEY]: { value: "http://127.0.0.1:7890", updatedAt: 1000 } });

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.dispatcher).toBeNull();
    expect(result.url).toBeNull();
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("非 docker 部署（edgeone/cf/vercel）同样不启用", async () => {
    for (const platform of ["edgeone", "cf", "vercel"]) {
      vi.resetModules();
      setPlatform(platform);
      const { getUpstreamProxy } = await loadModule();
      const result = await getUpstreamProxy(mockDb, mockEnv);
      expect(result.dispatcher).toBeNull();
    }
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

describe("配置解析与代理创建", () => {
  it("无配置记录 → null（直连）", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({});

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.dispatcher).toBeNull();
    expect(result.url).toBeNull();
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: CONFIG_KEY } })
    );
  });

  it("旧版纯 URL 字符串 → 视为单代理全部平台", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({ [CONFIG_KEY]: { value: "http://127.0.0.1:7890", updatedAt: 1000 } });

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.url).toBe("http://127.0.0.1:7890");
    expect(result.dispatcher).not.toBeNull();
    // undici ProxyAgent 实例特征：具有 dispatch/close 方法
    expect(typeof (result.dispatcher as Dispatcher).dispatch).toBe("function");
    expect(typeof (result.dispatcher as Dispatcher).close).toBe("function");
  });

  it("JSON 单代理配置 → 返回 ProxyAgent", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls: ["https://proxy.example.com:8443"], platformIds: [], healthCheckUrl: "https://example.com/ping" }),
        updatedAt: 1000,
      },
    });

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.url).toBe("https://proxy.example.com:8443");
    expect(result.dispatcher).not.toBeNull();
  });

  it("空 JSON 配置 {} → null（清空恢复直连）", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({ [CONFIG_KEY]: { value: "{}", updatedAt: 2000 } });

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.dispatcher).toBeNull();
    expect(result.url).toBeNull();
  });

  it("不支持的协议（socks5://）被忽略 → null 且不抛错", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls: ["socks5://127.0.0.1:1080"], platformIds: [] }),
        updatedAt: 1000,
      },
    });

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.dispatcher).toBeNull();
  });

  it("非法 JSON（非对象非字符串）→ null", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({ [CONFIG_KEY]: { value: "123", updatedAt: 1000 } });

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.dispatcher).toBeNull();
  });
});

describe("平台白名单", () => {
  it("platformIds 为空 → 所有平台（含传 platformId）都走代理", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: ["http://127.0.0.1:7890"], platformIds: [] }), updatedAt: 1000 },
    });

    const withPlatform = await getUpstreamProxy(mockDb, mockEnv, "p1");
    const withoutPlatform = await getUpstreamProxy(mockDb, mockEnv);

    expect(withPlatform.dispatcher).not.toBeNull();
    expect(withoutPlatform.dispatcher).not.toBeNull();
  });

  it("platformIds 非空且平台不在列表 → 该平台直连", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: ["http://127.0.0.1:7890"], platformIds: ["p1"] }), updatedAt: 1000 },
    });

    const result = await getUpstreamProxy(mockDb, mockEnv, "p2");

    expect(result.dispatcher).toBeNull();
    expect(result.url).toBeNull();
  });

  it("platformIds 非空且平台在列表 → 走代理", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: ["http://127.0.0.1:7890"], platformIds: ["p1"] }), updatedAt: 1000 },
    });

    const result = await getUpstreamProxy(mockDb, mockEnv, "p1");

    expect(result.dispatcher).not.toBeNull();
    expect(result.url).toBe("http://127.0.0.1:7890");
  });

  it("platformIds 非空但调用方未传 platformId → 直连（严格白名单语义）", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: ["http://127.0.0.1:7890"], platformIds: ["p1"] }), updatedAt: 1000 },
    });

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.dispatcher).toBeNull();
    expect(result.url).toBeNull();
  });
});

describe("多代理轮询", () => {
  it("两个代理按 round-robin 交替选择，第三个请求回到第一个", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls: ["http://127.0.0.1:7890", "http://127.0.0.1:7891"], platformIds: [] }),
        updatedAt: 1000,
      },
    });

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);
    const third = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.url).toBe("http://127.0.0.1:7890");
    expect(second.url).toBe("http://127.0.0.1:7891");
    expect(third.url).toBe("http://127.0.0.1:7890");
    // 不同 URL 对应不同 ProxyAgent 实例（池化缓存）
    expect(second.dispatcher).not.toBe(first.dispatcher);
    expect(third.dispatcher).toBe(first.dispatcher);
  });

  it("健康表标记 fail 的代理被跳过，仅轮询健康代理", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls: ["http://127.0.0.1:7890", "http://127.0.0.1:7891"], platformIds: [] }),
        updatedAt: 1000,
      },
      [HEALTH_KEY]: {
        value: JSON.stringify({
          "http://127.0.0.1:7891": { status: "fail", latencyMs: 0, checkedAt: 1000, failCount: 5 },
        }),
        updatedAt: 1000,
      },
    });

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.url).toBe("http://127.0.0.1:7890");
    expect(second.url).toBe("http://127.0.0.1:7890");
  });

  it("全部代理健康异常 → 回退全部代理轮询（不改变走代理语义）", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls: ["http://127.0.0.1:7890", "http://127.0.0.1:7891"], platformIds: [] }),
        updatedAt: 1000,
      },
      [HEALTH_KEY]: {
        value: JSON.stringify({
          "http://127.0.0.1:7890": { status: "fail", latencyMs: 0, checkedAt: 1000, failCount: 5 },
          "http://127.0.0.1:7891": { status: "fail", latencyMs: 0, checkedAt: 1000, failCount: 5 },
        }),
        updatedAt: 1000,
      },
    });

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.url).toBe("http://127.0.0.1:7890");
    expect(second.url).toBe("http://127.0.0.1:7891");
  });
});

describe("markProxyFailure 失败回标记", () => {
  const URL_A = "http://127.0.0.1:7890";
  const URL_B = "http://127.0.0.1:7891";

  function configWith(urls: string[]) {
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls, platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
  }

  it("未达阈值不写健康表，代理仍参与轮询", async () => {
    const { markProxyFailure, getUpstreamProxy } = await loadModule();
    configWith([URL_A, URL_B]);

    await markProxyFailure(mockDb, mockEnv, URL_A);
    await markProxyFailure(mockDb, mockEnv, URL_A);

    expect(mockUpsert).not.toHaveBeenCalled();
    // 未达阈值：A 仍可被选中（轮询游标从 B 开始）
    const result = await getUpstreamProxy(mockDb, mockEnv);
    expect(result.url).toBe(URL_A);
  });

  it("连续失败达阈值 → 写入健康表 fail 并跳过轮询", async () => {
    const { markProxyFailure, getUpstreamProxy } = await loadModule();
    configWith([URL_A, URL_B]);

    for (let i = 0; i < 3; i++) {
      await markProxyFailure(mockDb, mockEnv, URL_A);
    }

    // 健康表写入 fail 记录
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const upsertArgs = mockUpsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ key: HEALTH_KEY });
    const written = JSON.parse(upsertArgs.create.value) as Record<string, any>;
    expect(written[URL_A]).toMatchObject({ status: "fail", failCount: 3 });

    // A 被跳过，连续轮询只选中 B
    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);
    expect(first.url).toBe(URL_B);
    expect(second.url).toBe(URL_B);
  });

  it("已达阈值后重复标记不重复写表", async () => {
    const { markProxyFailure } = await loadModule();
    configWith([URL_A, URL_B]);

    for (let i = 0; i < 5; i++) {
      await markProxyFailure(mockDb, mockEnv, URL_A);
    }

    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });
});

describe("runProxyHealthCheck 健康检查", () => {
  const URL_A = "http://127.0.0.1:7890";
  const URL_B = "http://127.0.0.1:7891";
  const CHECK_URL = "https://www.google.com/generate_204";

  function configWith(urls: string[], healthCheckUrl?: string) {
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls, platformIds: [], healthCheckUrl: healthCheckUrl ?? CHECK_URL }),
        updatedAt: 1000,
      },
    });
  }

  it("全部探测成功 → 写入 ok 记录并返回结果", async () => {
    const { runProxyHealthCheck } = await loadModule();
    configWith([URL_A, URL_B]);
    const fetchMock = vi.fn(async (_input: any, init: any) => {
      // 探测必须真实经过代理：断言 dispatcher 注入
      expect(init?.dispatcher).toBeDefined();
      return { ok: true, status: 204 };
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    expect(results[URL_A]).toMatchObject({ status: "ok", latencyMs: expect.any(Number) });
    expect(results[URL_B]).toMatchObject({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const upsertArgs = mockUpsert.mock.calls[0][0];
    const written = JSON.parse(upsertArgs.create.value) as Record<string, any>;
    expect(written[URL_A]).toMatchObject({ status: "ok", failCount: 0 });
  });

  it("探测失败 → 写入 fail 记录，failCount 从历史递增", async () => {
    const { runProxyHealthCheck } = await loadModule();
    configWith([URL_A]);
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: [URL_A], platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: {
        value: JSON.stringify({ [URL_A]: { status: "fail", latencyMs: 0, checkedAt: 1000, failCount: 2 } }),
        updatedAt: 1000,
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connect ECONNREFUSED"); }));

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    expect(results[URL_A]).toMatchObject({ status: "fail", failCount: 3 });
    const written = JSON.parse(mockUpsert.mock.calls[0][0].create.value) as Record<string, any>;
    expect(written[URL_A]).toMatchObject({ status: "fail", failCount: 3 });
  });

  it("探测成功 → 清除进程内失败标记并清零 failCount", async () => {
    const { markProxyFailure, runProxyHealthCheck, getUpstreamProxy } = await loadModule();
    configWith([URL_A]);

    for (let i = 0; i < 3; i++) {
      await markProxyFailure(mockDb, mockEnv, URL_A);
    }
    // 阈值达：A 已进入进程内黑名单
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    expect(results[URL_A]).toMatchObject({ status: "ok", failCount: 0 });
    // 黑名单清除：A 恢复可被选中
    const result = await getUpstreamProxy(mockDb, mockEnv);
    expect(result.url).toBe(URL_A);
  });

  it("未配置代理 → 返回空结果且不写表", async () => {
    const { runProxyHealthCheck } = await loadModule();
    setConfigRows({});

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    expect(results).toEqual({});
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("getProxyHealth 读取", () => {
  it("非 docker 部署返回空对象", async () => {
    setPlatform("edgeone");
    const { getProxyHealth } = await loadModule();

    const results = await getProxyHealth(mockDb, mockEnv);

    expect(results).toEqual({});
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("docker 部署读取健康表", async () => {
    const { getProxyHealth } = await loadModule();
    setConfigRows({
      [HEALTH_KEY]: {
        value: JSON.stringify({ "http://127.0.0.1:7890": { status: "ok", latencyMs: 42, checkedAt: 1000, failCount: 0 } }),
        updatedAt: 1000,
      },
    });

    const results = await getProxyHealth(mockDb, mockEnv);

    expect(results["http://127.0.0.1:7890"]).toMatchObject({ status: "ok", latencyMs: 42 });
  });

  it("健康表脏数据（非法条目）被丢弃", async () => {
    const { getProxyHealth } = await loadModule();
    setConfigRows({
      [HEALTH_KEY]: {
        value: JSON.stringify({
          "http://127.0.0.1:7890": { status: "ok", latencyMs: 42, checkedAt: 1000, failCount: 0 },
          "http://127.0.0.1:7891": { status: "weird", latencyMs: 1, checkedAt: 1, failCount: 1 },
          "http://127.0.0.1:7892": "not-an-object",
        }),
        updatedAt: 1000,
      },
    });

    const results = await getProxyHealth(mockDb, mockEnv);

    expect(Object.keys(results)).toEqual(["http://127.0.0.1:7890"]);
  });
});

describe("缓存与更新", () => {
  it("TTL 内重复调用复用缓存（配置/健康/拉取各一次全量读取 + 一次失效检查）", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: ["http://127.0.0.1:7890"], platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });

    await getUpstreamProxy(mockDb, mockEnv);
    await getUpstreamProxy(mockDb, mockEnv);

    // 第一次全量读取（config+health+pool）+ 第二次失效检查（config+health+pool）
    expect(mockFindFirst).toHaveBeenCalledTimes(6);
    expect(mockFindFirst.mock.calls[0][0].select).toHaveProperty("value");
    expect(mockFindFirst.mock.calls[3][0].select).not.toHaveProperty("value");
  });

  it("配置 updatedAt 变化 → 强制重载新代理地址，旧 ProxyAgent 被 close 释放", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: "http://127.0.0.1:7890", updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    const first = await getUpstreamProxy(mockDb, mockEnv);

    // 管理后台保存：值变化 + updatedAt 变化
    setConfigRows({
      [CONFIG_KEY]: { value: "http://127.0.0.1:7891", updatedAt: 2000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    const second = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.url).toBe("http://127.0.0.1:7890");
    expect(second.url).toBe("http://127.0.0.1:7891");
    expect(second.dispatcher).not.toBe(first.dispatcher);
    // 旧代理实例已从池中释放（releaseStaleAgents 触发 close）
    expect(createdAgents).toHaveLength(2);
    expect(createdAgents[0].close).toHaveBeenCalled();
    expect(createdAgents[1].close).not.toHaveBeenCalled();
  });

  it("配置从有到无（清空保存）→ 恢复直连返回 null", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: "http://127.0.0.1:7890", updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    await getUpstreamProxy(mockDb, mockEnv);

    // 清空配置 + updatedAt 变化
    setConfigRows({
      [CONFIG_KEY]: { value: "{}", updatedAt: 2000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.dispatcher).toBeNull();
    expect(result.url).toBeNull();
  });

  it("配置行缺失时第二次调用命中缓存短路（不重复全量读库）", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({});

    await getUpstreamProxy(mockDb, mockEnv);
    await getUpstreamProxy(mockDb, mockEnv);

    // 无配置时健康表不会被读取（config null 提前返回）：
    // 第一次全量读取配置 + 第二次失效检查（行缺失时 updatedAt 归一到 null
    // 与缓存一致，短路命中不再全量读）
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
    expect(mockFindFirst.mock.calls[0][0].select).toHaveProperty("value");
    expect(mockFindFirst.mock.calls[1][0].select).not.toHaveProperty("value");
  });

  it("数据库读取失败 → 返回 null 不抛错", async () => {
    const { getUpstreamProxy } = await loadModule();
    mockFindFirst.mockRejectedValue(new Error("db down"));

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.dispatcher).toBeNull();
    expect(result.url).toBeNull();
  });
});

describe("组路由与拉取结果合并", () => {
  const URL_A = "http://127.0.0.1:7890";
  const URL_B = "http://127.0.0.1:7891";
  const POOL_KEY = "system:upstream_proxy_pool";

  function configWith(groups: any[], platformIds: string[] = [], platformGroup: Record<string, string> = {}) {
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ groups, platformIds, platformGroup }),
        updatedAt: 1000,
      },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
  }

  it("平台绑定组：绑定平台固定使用指定组", async () => {
    const { getUpstreamProxy } = await loadModule();
    configWith(
      [
        { name: "g1", urls: [URL_A] },
        { name: "g2", urls: [URL_B] },
      ],
      [],
      { p1: "g2" }
    );

    const result = await getUpstreamProxy(mockDb, mockEnv, "p1");

    expect(result.url).toBe(URL_B);
  });

  it("未绑定平台走默认组（第一组）", async () => {
    const { getUpstreamProxy } = await loadModule();
    configWith(
      [
        { name: "g1", urls: [URL_A] },
        { name: "g2", urls: [URL_B] },
      ],
      ["p2"]
    );

    const result = await getUpstreamProxy(mockDb, mockEnv, "p2");

    expect(result.url).toBe(URL_A);
  });

  it("绑定平台隐含走代理（无需重复加入白名单），白名单平台走默认组", async () => {
    const { getUpstreamProxy } = await loadModule();
    configWith(
      [
        { name: "g1", urls: [URL_A] },
        { name: "g2", urls: [URL_B] },
      ],
      ["p2"],
      { p1: "g2" }
    );

    // p1 不在白名单但绑定了组 → 仍走代理（g2）
    const bound = await getUpstreamProxy(mockDb, mockEnv, "p1");
    expect(bound.url).toBe(URL_B);

    // p2 在白名单未绑定 → 默认组（g1）
    const whitelisted = await getUpstreamProxy(mockDb, mockEnv, "p2");
    expect(whitelisted.url).toBe(URL_A);
  });

  it("绑定到不存在的组 → 回退默认组", async () => {
    const { getUpstreamProxy } = await loadModule();
    configWith([{ name: "g1", urls: [URL_A] }], [], { p1: "ghost" });

    const result = await getUpstreamProxy(mockDb, mockEnv, "p1");

    expect(result.url).toBe(URL_A);
  });

  it("组内候选 = 拉取结果 ∪ 手动代理（去重后按组轮询）", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: "https://src", urls: [URL_A] }], platformIds: [] }),
        updatedAt: 1000,
      },
      [POOL_KEY]: { value: JSON.stringify({ g1: [URL_B, URL_A] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });

    // 去重后 [URL_A, URL_B]，round-robin 交替
    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.url).toBe(URL_A);
    expect(second.url).toBe(URL_B);
  });

  it("组内无代理（拉取尚未成功且无手动）→ 直连", async () => {
    const { getUpstreamProxy } = await loadModule();
    configWith([{ name: "g1", sourceUrl: "https://src" }]);

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.url).toBeNull();
    expect(result.dispatcher).toBeNull();
  });

  it("旧版配置（顶层 urls）在组体系下仍按单组工作（兼容）", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: [URL_A, URL_B], platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.url).toBe(URL_A);
    expect(second.url).toBe(URL_B);
  });
});

describe("pullProxyGroups 拉取", () => {
  const URL_A = "http://127.0.0.1:7890";
  const URL_B = "http://127.0.0.1:7891";
  const POOL_KEY = "system:upstream_proxy_pool";
  const SRC = "https://example.com/proxies.txt";

  function configWith(groups: any[]) {
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ groups, platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
  }

  function stubFetch(text: string | Error) {
    if (text instanceof Error) {
      vi.stubGlobal("fetch", vi.fn(async () => { throw text; }));
    } else {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => text })));
    }
  }

  /** 取最后一次写入指定 key 的 upsert 参数 */
  function lastUpsertFor(key: string) {
    const calls = mockUpsert.mock.calls.filter((c) => c[0].where.key === key);
    return calls[calls.length - 1][0];
  }

  it("非 docker 部署返回空、不写库", async () => {
    setPlatform("edgeone");
    const { pullProxyGroups } = await loadModule();
    configWith([{ name: "g1", sourceUrl: SRC }]);

    const results = await pullProxyGroups(mockDb, mockEnv);

    expect(results).toEqual({});
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("拉取解析：裸 host:port 补全、协议头保留、脏行与重复忽略", async () => {
    const { pullProxyGroups } = await loadModule();
    configWith([{ name: "g1", sourceUrl: SRC }]);
    stubFetch(
      "127.0.0.1:7890\nhttp://127.0.0.1:7891\nsocks5://127.0.0.1:1080\n\n# comment\nhttp://127.0.0.1:7890"
    );

    const results = await pullProxyGroups(mockDb, mockEnv);

    expect(results.g1).toMatchObject({ pulled: 2, added: 2, removed: 0, kept: 0, total: 2 });
    const upsertArgs = lastUpsertFor(POOL_KEY);
    const pool = JSON.parse(upsertArgs.create.value) as Record<string, any>;
    expect(pool.g1).toEqual(["http://127.0.0.1:7890", "http://127.0.0.1:7891"]);
  });

  it("交集：健康度记录保留且 status 切换为 ok，进程内黑名单清除恢复在池", async () => {
    const { markProxyFailure, pullProxyGroups, getUpstreamProxy } = await loadModule();
    configWith([{ name: "g1", sourceUrl: SRC }]);
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }), updatedAt: 1000 },
      [POOL_KEY]: { value: JSON.stringify({ g1: [URL_A] }), updatedAt: 1000 },
      [HEALTH_KEY]: {
        value: JSON.stringify({ [URL_A]: { status: "fail", latencyMs: 0, checkedAt: 1000, failCount: 5 } }),
        updatedAt: 1000,
      },
    });
    // 达阈值：A 进入进程内黑名单（markProxyFailure 第 3 次会覆写健康表 failCount=3）
    for (let i = 0; i < 3; i++) {
      await markProxyFailure(mockDb, mockEnv, URL_A);
    }
    // 拉取返回同一代理 → 交集
    stubFetch(URL_A);

    await pullProxyGroups(mockDb, mockEnv);

    const health = JSON.parse(lastUpsertFor(HEALTH_KEY).create.value) as Record<string, any>;
    // 健康度保留（failCount 来自预置健康表，markProxyFailure 的覆写被 mock 行
    // 重读恢复，此处验证的是「保留历史计数」语义）
    expect(health[URL_A]).toMatchObject({ status: "ok", failCount: 5 });
    // 黑名单清除：A 恢复可被选中
    const result = await getUpstreamProxy(mockDb, mockEnv);
    expect(result.url).toBe(URL_A);
  });

  it("移除：健康记录随代理删除、代理连接释放，交集保留并恢复", async () => {
    const { pullProxyGroups, getUpstreamProxy } = await loadModule();
    configWith([{ name: "g1", sourceUrl: SRC }]);
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }), updatedAt: 1000 },
      [POOL_KEY]: { value: JSON.stringify({ g1: [URL_A, URL_B] }), updatedAt: 1000 },
      [HEALTH_KEY]: {
        value: JSON.stringify({
          [URL_A]: { status: "ok", latencyMs: 10, checkedAt: 1000, failCount: 0 },
          [URL_B]: { status: "fail", latencyMs: 0, checkedAt: 1000, failCount: 2 },
        }),
        updatedAt: 1000,
      },
    });
    // 先让 URL_A 建立代理连接（候选 [A,B]，round-robin 首个选中 A）
    const before = await getUpstreamProxy(mockDb, mockEnv);
    expect(before.url).toBe(URL_A);

    // 新列表仅剩 B：A 被移除，B 为交集
    stubFetch(URL_B);
    const results = await pullProxyGroups(mockDb, mockEnv);

    expect(results.g1).toMatchObject({ added: 0, removed: 1, kept: 1, total: 1 });
    const pool = JSON.parse(lastUpsertFor(POOL_KEY).create.value) as Record<string, any>;
    expect(pool.g1).toEqual([URL_B]);
    const health = JSON.parse(lastUpsertFor(HEALTH_KEY).create.value) as Record<string, any>;
    expect(health[URL_A]).toBeUndefined();
    // 交集 B：健康度保留（failCount 2）且 status 恢复 ok
    expect(health[URL_B]).toMatchObject({ status: "ok", failCount: 2 });
    // URL_A 的代理连接被释放
    const closed = createdAgents.find((a) => a.url === URL_A);
    expect(closed?.close).toHaveBeenCalled();
  });

  it("拉取失败（网络错误）→ 保留旧列表并记 error", async () => {
    const { pullProxyGroups } = await loadModule();
    configWith([{ name: "g1", sourceUrl: SRC }]);
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }), updatedAt: 1000 },
      [POOL_KEY]: { value: JSON.stringify({ g1: [URL_A] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    stubFetch(new Error("network down"));

    const results = await pullProxyGroups(mockDb, mockEnv);

    expect(results.g1.error).toBeDefined();
    expect(results.g1.pulled).toBe(0);
    const pool = JSON.parse(lastUpsertFor(POOL_KEY).create.value) as Record<string, any>;
    expect(pool.g1).toEqual([URL_A]);
  });

  it("拉取失败 → 不重置已记录的健康状态（fail 记录保留，不误恢复）", async () => {
    const { pullProxyGroups } = await loadModule();
    configWith([{ name: "g1", sourceUrl: SRC }]);
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }), updatedAt: 1000 },
      [POOL_KEY]: { value: JSON.stringify({ g1: [URL_A] }), updatedAt: 1000 },
      [HEALTH_KEY]: {
        value: JSON.stringify({ [URL_A]: { status: "fail", latencyMs: 0, checkedAt: 1000, failCount: 3 } }),
        updatedAt: 1000,
      },
    });
    stubFetch(new Error("network down"));

    const results = await pullProxyGroups(mockDb, mockEnv);

    expect(results.g1.error).toBeDefined();
    const health = JSON.parse(lastUpsertFor(HEALTH_KEY).create.value) as Record<string, any>;
    expect(health[URL_A]).toMatchObject({ status: "fail", failCount: 3 });
  });

  it("空结果（HTTP 200 但无有效行）→ 保留旧列表并记 error", async () => {
    const { pullProxyGroups } = await loadModule();
    configWith([{ name: "g1", sourceUrl: SRC }]);
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }), updatedAt: 1000 },
      [POOL_KEY]: { value: JSON.stringify({ g1: [URL_A] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    stubFetch("  \n\n");

    const results = await pullProxyGroups(mockDb, mockEnv);

    expect(results.g1.error).toBe("empty");
    expect(results.g1.pulled).toBe(0);
    const pool = JSON.parse(lastUpsertFor(POOL_KEY).create.value) as Record<string, any>;
    expect(pool.g1).toEqual([URL_A]);
  });

  it("无拉取源组（纯手动）→ 不拉取不写表", async () => {
    const { pullProxyGroups } = await loadModule();
    configWith([{ name: "g1", urls: [URL_A] }]);
    stubFetch(URL_B);

    const results = await pullProxyGroups(mockDb, mockEnv);

    expect(results).toEqual({});
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("拉取源 HTTP 非 2xx → 保留旧列表并记 error", async () => {
    const { pullProxyGroups } = await loadModule();
    configWith([{ name: "g1", sourceUrl: SRC }]);
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }), updatedAt: 1000 },
      [POOL_KEY]: { value: JSON.stringify({ g1: [URL_A] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "" })));

    const results = await pullProxyGroups(mockDb, mockEnv);

    expect(results.g1.error).toContain("500");
    const pool = JSON.parse(lastUpsertFor(POOL_KEY).create.value) as Record<string, any>;
    expect(pool.g1).toEqual([URL_A]);
  });
});