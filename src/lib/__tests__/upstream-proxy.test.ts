/**
 * upstream-proxy.ts 出站代理测试
 *
 * 覆盖：
 * - 非 Docker 部署（DEPLOY_PLATFORM≠docker）不启用，且不查询数据库
 * - 配置解析：旧版纯 URL 字符串 / JSON（urls + platformIds + healthCheckUrl）
 * - 平台白名单：空列表=全部平台；非空时仅勾选平台走代理
 * - 多代理 round-robin 轮询（交替选择，health fail / 连续失败跳过）
 * - 可用性×延迟加权选择：成功率档位权重主导分配、延迟微调、持续 429
 *   的代理即使延迟最低也不选中、按权重比例平滑分配不连续独占
 * - markProxyFailure：网络层失败达阈值后写入健康表并跳过轮询
 * - runProxyHealthCheck：探测结果写入健康表（cron 与管理页共用）
 * - 缓存：TTL 内复用；configs.updatedAt 变化强制重载
 * - 业务流量统计与路由降权：recordProxyTraffic 分类 / isProxyStatDegraded
 *   阈值与窗口 / 统计降权跳过 / 全部降权回退轮询
 *
 * 模块级缓存跨测试共享，每个用例用 vi.resetModules + 动态 import 取新模块实例
 * （与 request-templates.test.ts 的模式一致）
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Dispatcher } from "undici";

// 内存"数据库"：upsert 持久化写入、findFirst 读回。写锁修复后健康表读改写
// 必须基于最新已落库状态重读，静态 mock 无法模拟（此前各路径用读取时刻的
// 旧快照整表覆盖，mock 不持久化也能通过）
const { dbRows } = vi.hoisted(() => ({
  dbRows: {} as Record<string, { value: string; updatedAt: number } | null>,
}));
const mockFindFirst = vi.fn();
const mockUpsert = vi.fn(async (args: any) => {
  const key: string | undefined = args?.where?.key;
  if (key !== undefined) {
    dbRows[key] = {
      value: args.create?.value ?? args.update?.value ?? "",
      updatedAt: args.create?.updatedAt ?? args.update?.updatedAt ?? 0,
    };
  }
  return {};
});
// 锁 CAS（updateMany where value 等值匹配）：仅当行存在且 value 与期望一致
// 才更新并返回 count=1，否则 count=0（多实例互斥语义；健康检查锁与进度共用）
const mockUpdateMany = vi.fn(async (args: any) => {
  const key: string | undefined = args?.where?.key;
  const row = key !== undefined ? dbRows[key] : undefined;
  if (key !== undefined && row && args?.where?.value !== undefined && row.value === args.where.value) {
    dbRows[key] = {
      value: args.data?.value ?? row.value,
      updatedAt: args.data?.updatedAt ?? row.updatedAt,
    };
    return { count: 1 };
  }
  return { count: 0 };
});
const mockFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    configs: { findFirst: mockFindFirst, findMany: mockFindMany, upsert: mockUpsert, updateMany: mockUpdateMany },
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

// mock fetch-socks：socks4/socks5 代理经 socksDispatcher 创建（undici Agent 子类），
// 捕获实例与解析出的 socks 目标列表（类型/主机/端口/凭据）
const { createdSocksDispatchers } = vi.hoisted(() => ({ createdSocksDispatchers: [] as any[] }));
vi.mock("fetch-socks", () => ({
  socksDispatcher: (proxies: any) => {
    const dispatcher = {
      proxies,
      close: vi.fn(async () => {}),
      dispatch() {},
    };
    createdSocksDispatchers.push(dispatcher);
    return dispatcher;
  },
}));

const mockDb = {} as D1Database;
const mockEnv = { DB_TYPE: "pg" } as any;
const CONFIG_KEY = "system:upstream_proxy";
const HEALTH_KEY = "system:upstream_proxy_health";

let originalPlatform: string | undefined;
let originalDbType: string | undefined;
let originalProxyDisabled: string | undefined;

function setPlatform(value: string | undefined) {
  if (value === undefined) delete process.env.DEPLOY_PLATFORM;
  else process.env.DEPLOY_PLATFORM = value;
}

/** 设置设备级禁用环境变量（undefined = 清除） */
function setProxyDisabled(value: string | undefined) {
  if (value === undefined) delete process.env.UPSTREAM_PROXY_DISABLED;
  else process.env.UPSTREAM_PROXY_DISABLED = value;
}

/** 按查询 key 返回配置行（失效检查与全量读取共用同一 mock 实现）；
 *  替换语义：清空内存库再写入（upsert 已持久化，显式 set 覆盖旧行） */
function setConfigRows(rows: Record<string, { value: string; updatedAt: number } | null>) {
  for (const k of Object.keys(dbRows)) delete dbRows[k];
  Object.assign(dbRows, rows);

  mockFindMany.mockImplementation((args: any) => {
    const keys: string[] | undefined = args?.where?.key?.in;
    if (keys) {
      const rows = keys.map((k: string) => (dbRows[k] ? { key: k, value: dbRows[k]!.value } : null)).filter(Boolean);
      return Promise.resolve(rows);
    }
    return Promise.resolve([]);
  });
  mockFindFirst.mockImplementation((args: any) => {
    const key: string | undefined = args?.where?.key;
    const row = key !== undefined && key in dbRows ? dbRows[key] : null;
    return Promise.resolve(row ? { value: row.value, updatedAt: row.updatedAt } : null);
  });
}

async function loadModule() {
  return import("../upstream-proxy");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // 内存库按测隔离清空（upsert 已持久化，不能依赖用例自行 setConfigRows）
  for (const k of Object.keys(dbRows)) delete dbRows[k];
  createdAgents.length = 0;
  createdSocksDispatchers.length = 0;
  originalPlatform = process.env.DEPLOY_PLATFORM;
  originalDbType = process.env.DB_TYPE;
  originalProxyDisabled = process.env.UPSTREAM_PROXY_DISABLED;
  setPlatform("docker");
  setProxyDisabled(undefined);
});

afterEach(() => {
  setPlatform(originalPlatform);
  if (originalDbType === undefined) delete process.env.DB_TYPE;
  else process.env.DB_TYPE = originalDbType;
  setProxyDisabled(originalProxyDisabled);
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

  it("socks4/socks5 代理 → 经 fetch-socks socksDispatcher 创建转发 agent（类型/凭据解析、池化复用）", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({
          urls: ["socks5://user:pass@127.0.0.1:1080", "socks4://127.0.0.1:1081"],
          platformIds: [],
        }),
        updatedAt: 1000,
      },
    });

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);
    const third = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.url).toBe("socks5://user:pass@127.0.0.1:1080");
    expect(second.url).toBe("socks4://127.0.0.1:1081");
    expect(third.url).toBe("socks5://user:pass@127.0.0.1:1080");
    expect(createdSocksDispatchers).toHaveLength(2);
    // socks5 带凭据：类型/主机/端口/凭据解析（decodeURIComponent）
    expect(createdSocksDispatchers[0].proxies).toEqual([
      { type: 5, host: "127.0.0.1", port: 1080, userId: "user", password: "pass" },
    ]);
    // socks4 无凭据：仅类型/主机/端口
    expect(createdSocksDispatchers[1].proxies).toEqual([{ type: 4, host: "127.0.0.1", port: 1081 }]);
    // 池化复用：第三次调用复用第一次的实例（不新建、不泄漏）
    expect(third.dispatcher).toBe(first.dispatcher);
    expect(createdSocksDispatchers).toHaveLength(2);
    expect(createdAgents).toHaveLength(0);
  });

  it("socks 凭据含畸形百分号转义 → 原样保留不抛错（URIError 防护）；IPv6 主机去方括号", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({
          urls: ["socks5://user:pa%ss@127.0.0.1:1080", "socks4://[::1]:1081"],
          platformIds: [],
        }),
        updatedAt: 1000,
      },
    });

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.dispatcher).not.toBeNull();
    expect(second.dispatcher).not.toBeNull();
    // WHATWG URL 对 userinfo 中畸形 % 序列原样保留，decodeURIComponent 抛 URIError
    // 会导致请求 500——解码失败回退原值（不抛错、代理仍可路由）
    expect(createdSocksDispatchers[0].proxies).toEqual([
      { type: 5, host: "127.0.0.1", port: 1080, userId: "user", password: "pa%ss" },
    ]);
    // IPv6 字面量去方括号后交给 socks 库（[::1] → ::1）
    expect(createdSocksDispatchers[1].proxies).toEqual([{ type: 4, host: "::1", port: 1081 }]);
  });

  it("不支持的协议（ftp://）被忽略 → null 且不抛错", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls: ["ftp://127.0.0.1:21"], platformIds: [] }),
        updatedAt: 1000,
      },
    });

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.dispatcher).toBeNull();
    expect(result.url).toBeNull();
  });

  it("非法 JSON（非对象非字符串）→ null", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({ [CONFIG_KEY]: { value: "123", updatedAt: 1000 } });

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.dispatcher).toBeNull();
  });

  it("健康检查间隔：合法值生效，供调度器动态 spec 读取", async () => {
    const { getUpstreamProxy, getHealthCheckIntervalMin } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({
          urls: ["https://proxy.example.com:8443"],
          platformIds: [],
          healthCheckIntervalMin: 10,
        }),
        updatedAt: 1000,
      },
    });

    // 缓存未加载时返回默认 5
    expect(getHealthCheckIntervalMin()).toBe(5);
    await getUpstreamProxy(mockDb, mockEnv);
    // 配置加载后返回配置值
    expect(getHealthCheckIntervalMin()).toBe(10);
  });

  it("健康检查间隔：缺失/非法/越界回退默认 5", async () => {
    for (const value of [undefined, 0, 1441, 5.5, "10", "abc"]) {
      vi.resetModules();
      const { getUpstreamProxy, getHealthCheckIntervalMin } = await loadModule();
      const config: Record<string, unknown> = { urls: ["https://proxy.example.com:8443"], platformIds: [] };
      if (value !== undefined) config.healthCheckIntervalMin = value;
      setConfigRows({ [CONFIG_KEY]: { value: JSON.stringify(config), updatedAt: 1000 } });

      await getUpstreamProxy(mockDb, mockEnv);

      expect(getHealthCheckIntervalMin()).toBe(5);
    }
  });

  it("组名 \"new\" 为保留名：跳过该组不参与路由（前端新建页路由 id===\"new\"，服务端同步拒绝，API 直连无法创建）", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({
          groups: [
            { name: "new", urls: ["http://127.0.0.1:7890"] },
            { name: "g1", urls: ["http://127.0.0.1:7891"] },
          ],
          platformIds: [],
        }),
        updatedAt: 1000,
      },
    });

    const result = await getUpstreamProxy(mockDb, mockEnv);

    // "new" 组被丢弃，剩余组正常路由（不抛错）
    expect(result.url).toBe("http://127.0.0.1:7891");
    expect(result.dispatcher).not.toBeNull();
    expect(createdAgents).toHaveLength(1);
  });

  it("仅含保留名 \"new\" 组 → 无有效代理（直连，不抛错）", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ groups: [{ name: "new", urls: ["http://127.0.0.1:7890"] }], platformIds: [] }),
        updatedAt: 1000,
      },
    });

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.dispatcher).toBeNull();
    expect(result.url).toBeNull();
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

  it("全部代理健康异常（fail 条目含实测延迟）→ 回退轮询而非固定打向最低延迟的 fail 代理", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls: ["http://127.0.0.1:7890", "http://127.0.0.1:7891"], platformIds: [] }),
        updatedAt: 1000,
      },
      [HEALTH_KEY]: {
        // 健康检查写入的 fail 条目 latencyMs 是实测探测耗时（>0），
        // 若 fallback 复用延迟最优选择会固定打向最低延迟的 fail 代理
        value: JSON.stringify({
          "http://127.0.0.1:7890": { status: "fail", latencyMs: 500, checkedAt: 1000, failCount: 5 },
          "http://127.0.0.1:7891": { status: "fail", latencyMs: 100, checkedAt: 1000, failCount: 5 },
        }),
        updatedAt: 1000,
      },
    });

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);

    // 回退轮询分摊：两次调用不固定同一代理（7891 延迟最低但已 fail）
    expect([first.url, second.url]).toContain("http://127.0.0.1:7890");
    expect([first.url, second.url]).toContain("http://127.0.0.1:7891");
  });

  it("全部候选异常 + 部分黑名单 → 回退排除黑名单代理（坏代理被禁用）", async () => {
    const { getUpstreamProxy, markProxyFailure } = await loadModule();
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
    // 7890 业务请求网络层连续失败达阈值进黑名单：回退分支同样排除，
    // 不再无差别轮询全部代理（原实现绕过黑名单，坏代理永远被选中）
    for (let i = 0; i < 3; i++) {
      await markProxyFailure(mockDb, mockEnv, "http://127.0.0.1:7890");
    }

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.url).toBe("http://127.0.0.1:7891");
    expect(second.url).toBe("http://127.0.0.1:7891");
  });

  it("全部候选异常 + 部分统计降权 → 回退排除降权代理（出口受限代理不参与）", async () => {
    const { getUpstreamProxy, recordProxyTraffic } = await loadModule();
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
    // 7890 业务窗口内 5 次全失败 → 错误率 1.0 > 0.8 触发统计降权
    for (let i = 0; i < 5; i++) {
      recordProxyTraffic("http://127.0.0.1:7890", 0);
    }

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.url).toBe("http://127.0.0.1:7891");
    expect(second.url).toBe("http://127.0.0.1:7891");
  });

  it("全部候选异常且全部黑名单 → 兜底全量轮询（不放弃走代理语义）", async () => {
    const { getUpstreamProxy, markProxyFailure } = await loadModule();
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
    // 两代理均达黑名单阈值：回退池空 → 兜底全量轮询（黑名单随健康检查
    // 成功自动清除，全黑名单是暂时状态）
    for (const url of ["http://127.0.0.1:7890", "http://127.0.0.1:7891"]) {
      for (let i = 0; i < 3; i++) {
        await markProxyFailure(mockDb, mockEnv, url);
      }
    }

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.url).toBe("http://127.0.0.1:7890");
    expect(second.url).toBe("http://127.0.0.1:7891");
  });

  it("已知延迟：可用性×延迟加权轮询，低延迟代理占多数但不固定独占", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls: ["http://127.0.0.1:7890", "http://127.0.0.1:7891"], platformIds: [] }),
        updatedAt: 1000,
      },
      [HEALTH_KEY]: {
        value: JSON.stringify({
          "http://127.0.0.1:7890": { status: "ok", latencyMs: 120, checkedAt: 1000, failCount: 0 },
          "http://127.0.0.1:7891": { status: "ok", latencyMs: 45, checkedAt: 1000, failCount: 0 },
        }),
        updatedAt: 1000,
      },
    });

    // 无业务流量统计 → 可用性中性（2）；延迟微调：7891（45ms）权重 2.5 >
    // 7890（120ms）权重 1.875，比例 57:43。平滑加权轮询不连续独占：
    // 序列 7891/7890/7891（此前的 clash url-test 语义固定每次选 7891）
    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);
    const third = await getUpstreamProxy(mockDb, mockEnv);

    expect([first.url, second.url, third.url]).toEqual([
      "http://127.0.0.1:7891",
      "http://127.0.0.1:7890",
      "http://127.0.0.1:7891",
    ]);
  });

  it("延迟已知 + fail 混排：fail 代理被跳过，ok 中低延迟代理权重更高", async () => {
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls: ["http://127.0.0.1:7890", "http://127.0.0.1:7891", "http://127.0.0.1:7892"], platformIds: [] }),
        updatedAt: 1000,
      },
      [HEALTH_KEY]: {
        value: JSON.stringify({
          "http://127.0.0.1:7890": { status: "ok", latencyMs: 100, checkedAt: 1000, failCount: 0 },
          "http://127.0.0.1:7891": { status: "fail", latencyMs: 30, checkedAt: 1000, failCount: 5 },
          "http://127.0.0.1:7892": { status: "ok", latencyMs: 200, checkedAt: 1000, failCount: 0 },
        }),
        updatedAt: 1000,
      },
    });

    // 首轮：7891（延迟最低但 fail）被跳过，ok 中 7890 权重最高 → 选中
    const result = await getUpstreamProxy(mockDb, mockEnv);
    expect(result.url).toBe("http://127.0.0.1:7890");

    // 连续多次不固定同一代理：7892（权重 2.0）周期性获得份额
    const picks = new Set<string>();
    for (let i = 0; i < 6; i++) {
      picks.add((await getUpstreamProxy(mockDb, mockEnv)).url as string);
    }
    expect(picks.has("http://127.0.0.1:7892")).toBe(true);
    expect(picks.has("http://127.0.0.1:7891")).toBe(false);
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
    // 健康表仅写一次（锁行写入不在此列：锁 value 与健康表 value 分开断言）
    const healthUpserts = mockUpsert.mock.calls.filter((c) => c[0].where.key === HEALTH_KEY);
    expect(healthUpserts).toHaveLength(1);
    const written = JSON.parse(healthUpserts[0][0].create.value) as Record<string, any>;
    expect(written[URL_A]).toMatchObject({ status: "ok", failCount: 0 });
  });

  it("健康检查锁生命周期：先抢锁（upsert 锁行）→ 每批 CAS 续期 → 完成后 CAS 释放", async () => {
    const { runProxyHealthCheck, getProxyHealth } = await loadModule();
    configWith([URL_A, URL_B]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 204 })));

    await runProxyHealthCheck(mockDb, mockEnv);

    // acquire：锁行 upsert 一次（running=true）
    const lockUpserts = mockUpsert.mock.calls.filter((c) => c[0].where.key === "system:upstream_proxy_check_lock");
    expect(lockUpserts).toHaveLength(1);
    const acquired = JSON.parse(lockUpserts[0][0].create.value) as Record<string, any>;
    expect(acquired).toMatchObject({ running: true, total: 0, checked: 0 });
    // 批后续期 + finally 释放：2 次 CAS（1 批 = 续期 1 次 + 释放 1 次），
    // 释放值 running=false 且保留 final total/checked
    const casCalls = mockUpdateMany.mock.calls.filter((c) => c[0].where.key === "system:upstream_proxy_check_lock");
    expect(casCalls).toHaveLength(2);
    const released = JSON.parse(casCalls[1][0].data.value) as Record<string, any>;
    expect(released).toMatchObject({ running: false, total: 2, checked: 2 });
    // 进度落库后任意实例（此处新实例进程内无状态）读到同一进度
    const { progress } = await getProxyHealth(mockDb, mockEnv);
    expect(progress).toMatchObject({ running: false, total: 2, checked: 2 });
  });

  it("锁被其他实例持有（running 且未过期）→ 不执行探测，返回当前健康表（跨实例互斥）", async () => {
    const { runProxyHealthCheck, getProxyHealth } = await loadModule();
    configWith([URL_A, URL_B]);
    const nowSec = Math.floor(Date.now() / 1000);
    // 预置他人锁：running=true、未过期（进度 3/5）
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls: [URL_A, URL_B], platformIds: [], healthCheckUrl: CHECK_URL }),
        updatedAt: 1000,
      },
      ["system:upstream_proxy_check_lock"]: {
        value: JSON.stringify({
          owner: "other-instance",
          startedAt: nowSec - 60,
          expiresAt: nowSec + 600,
          running: true,
          total: 5,
          checked: 3,
        }),
        updatedAt: 1000,
      },
      [HEALTH_KEY]: {
        value: JSON.stringify({ [URL_A]: { status: "fail", latencyMs: 0, checkedAt: 900, failCount: 2 } }),
        updatedAt: 1000,
      },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    // 未抢到锁：不探测、不写健康表、不改锁
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
    // 返回当前健康表（调用方展示用）
    expect(results[URL_A]).toMatchObject({ status: "fail", failCount: 2 });
    // 他人进度原样保留（前端轮询读到检查中 3/5）
    const { progress } = await getProxyHealth(mockDb, mockEnv);
    expect(progress).toMatchObject({ running: true, total: 5, checked: 3 });
  });

  it("过期锁（running=true 但 expiresAt 已过）→ 可抢占：旧锁被覆盖并正常执行检查", async () => {
    const { runProxyHealthCheck } = await loadModule();
    configWith([URL_A, URL_B]);
    const nowSec = Math.floor(Date.now() / 1000);
    // 预置崩溃残留锁：running=true、已过期
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls: [URL_A, URL_B], platformIds: [], healthCheckUrl: CHECK_URL }),
        updatedAt: 1000,
      },
      ["system:upstream_proxy_check_lock"]: {
        value: JSON.stringify({
          owner: "crashed-instance",
          startedAt: nowSec - 3600,
          expiresAt: nowSec - 1800,
          running: true,
          total: 99,
          checked: 10,
        }),
        updatedAt: 1000,
      },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    // 过期锁可抢占：正常探测并写入健康表
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results[URL_A]).toMatchObject({ status: "ok" });
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
    const healthUpserts = mockUpsert.mock.calls.filter((c) => c[0].where.key === HEALTH_KEY);
    const written = JSON.parse(healthUpserts[0][0].create.value) as Record<string, any>;
    expect(written[URL_A]).toMatchObject({ status: "fail", failCount: 3 });
  });

  it("响应头到达但 body 读取失败（挂满超时被 abort）→ 判失败而非正常", async () => {
    const { runProxyHealthCheck } = await loadModule();
    configWith([URL_A]);
    // 模拟坏代理：响应头正常返回但响应体永不结束，10s 超时被 abort 中断
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => {
          throw new Error("This operation was aborted");
        },
      }))
    );

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    // 响应不完整 = 链路异常，不得显示"正常 · 10000ms"
    expect(results[URL_A]).toMatchObject({ status: "fail", failCount: 1 });
    // 延迟记录的是响应头到达耗时（TTFB），不是被 abort 顶满的超时值
    expect(results[URL_A]!.latencyMs).toBeLessThan(10000);
    const healthUpserts = mockUpsert.mock.calls.filter((c) => c[0].where.key === HEALTH_KEY);
    const written = JSON.parse(healthUpserts[0][0].create.value) as Record<string, any>;
    expect(written[URL_A]).toMatchObject({ status: "fail", failCount: 1 });
  });

  it("延迟按响应头到达计时（TTFB）：body 读取耗时不计入", async () => {
    const { runProxyHealthCheck } = await loadModule();
    configWith([URL_A]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // 响应头立即返回；body 需 300ms 才读完——延迟不得包含这段耗时
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => {
            await new Promise((r) => setTimeout(r, 300));
            return new ArrayBuffer(0);
          },
        };
      })
    );

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    expect(results[URL_A]).toMatchObject({ status: "ok" });
    expect(results[URL_A]!.latencyMs).toBeLessThan(300);
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

  it("未配置代理 → 返回空结果且不写健康表", async () => {
    const { runProxyHealthCheck } = await loadModule();
    setConfigRows({});

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    expect(results).toEqual({});
    // 无候选不进批循环：健康表零写入（锁行写入/释放不在此列）
    const healthUpserts = mockUpsert.mock.calls.filter((c) => c[0].where.key === HEALTH_KEY);
    expect(healthUpserts).toHaveLength(0);
  });

  it("大代理池分批探测：并发峰值不超过批次上限（不瞬间全量并发）", async () => {
    const { runProxyHealthCheck } = await loadModule();
    // 55 个代理（跨 3 批），模拟真实大源导入后的检查场景
    const urls = Array.from(
      { length: 55 },
      (_, i) => `http://10.0.0.${i % 250}:8080`
    );
    configWith(urls);
    let active = 0;
    let peak = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        active++;
        peak = Math.max(peak, active);
        // 事件循环让位使同批探测真实重叠，才能测得并发峰值
        await new Promise((r) => setTimeout(r, 0));
        active--;
        return { ok: true, status: 204 };
      })
    );

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    expect(Object.keys(results)).toHaveLength(55);
    // 并发受批次上限约束（此前全量并发下 peak 会等于代理总数）
    expect(peak).toBeLessThanOrEqual(20);
    // 批内仍有并发（非串行退化）
    expect(peak).toBeGreaterThan(1);
  });
});

describe("getProxyHealth 读取", () => {
  it("非 docker 部署返回空对象", async () => {
    setPlatform("edgeone");
    const { getProxyHealth } = await loadModule();

    const { results, progress } = await getProxyHealth(mockDb, mockEnv);

    expect(results).toEqual({});
    expect(progress).toMatchObject({ running: false, total: 0, checked: 0 });
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

    const { results } = await getProxyHealth(mockDb, mockEnv);

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

    const { results } = await getProxyHealth(mockDb, mockEnv);

    expect(Object.keys(results)).toEqual(["http://127.0.0.1:7890"]);
  });
});

describe("健康检查渐进进度", () => {
  const URL_A = "http://127.0.0.1:7890";
  const URL_B = "http://127.0.0.1:7891";

  it("分批探测：每批完成即合并写库（多次 upsert，值含已检查条目）", async () => {
    const { runProxyHealthCheck } = await loadModule();
    // 25 个代理 = 2 批（20 + 5）
    const urls = Array.from({ length: 25 }, (_, i) => `http://10.0.${i}.1:8080`);
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls, platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 204 })));

    await runProxyHealthCheck(mockDb, mockEnv);

    // 每批一次合并写库：2 批 = 2 次健康表 upsert（此前只在循环后写 1 次；
    // 锁行写入不在此列）
    const healthUpserts = mockUpsert.mock.calls.filter((c) => c[0].where.key === HEALTH_KEY);
    expect(healthUpserts).toHaveLength(2);
    const firstWrite = JSON.parse(healthUpserts[0][0].create.value) as Record<string, any>;
    const secondWrite = JSON.parse(healthUpserts[1][0].create.value) as Record<string, any>;
    // 首批写库只有前 20 个有结果（未检查的保留表内现状，空健康表 → 无条目）
    expect(Object.keys(firstWrite)).toHaveLength(20);
    // 末批写库全部 25 个（前批结果保留 + 本批新增）
    expect(Object.keys(secondWrite)).toHaveLength(25);
  });

  it("检查完成后进度复位（running=false）", async () => {
    const { runProxyHealthCheck, getHealthCheckProgress } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: [URL_A, URL_B], platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 204 })));

    await runProxyHealthCheck(mockDb, mockEnv);

    expect(getHealthCheckProgress()).toMatchObject({ running: false, total: 2, checked: 2 });
  });

  it("并发调用复用同一任务（runningCheck 单飞：不重复探测、进度不被覆盖）", async () => {
    const { runProxyHealthCheck, getHealthCheckProgress } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: [URL_A, URL_B], platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    // 首个探测挂起在 gate 上，锁定「runningCheck 已赋值、任务进行中」窗口
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => { resolveGate = r; });
    let startedResolve!: () => void;
    const started = new Promise<void>((r) => { startedResolve = r; });
    let fetchCount = 0;
    const fetchMock = vi.fn(async (_input: any) => {
      if (fetchCount++ === 0) {
        startedResolve(); // 首个探测发起 = 任务已进入批循环
        await gate;
      }
      return { ok: true, status: 204 };
    });
    vi.stubGlobal("fetch", fetchMock);

    const p1 = runProxyHealthCheck(mockDb, mockEnv);
    // 确定性等待首个 fetch 发起（非轮询：started 是即时信号），此时
    // runningCheck 已赋值；期间发起的第二个调用命中单飞复用
    await started;
    const p2 = runProxyHealthCheck(mockDb, mockEnv);
    resolveGate();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual(r2);
    // 只探测一轮（代理数 2，而非 4）
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getHealthCheckProgress()).toMatchObject({ running: false });
  });

  it("全部组禁用（无候选）→ 返回空且进度复位（不残留 running=true）", async () => {
    const { runProxyHealthCheck, getHealthCheckProgress } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ groups: [{ name: "g1", urls: [URL_A], enabled: false }], platformIds: [] }),
        updatedAt: 1000,
      },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    const fetchMock = vi.fn(async (_input: any) => ({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    expect(results).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    // 入口即设置进度，early return 由 finally 复位
    expect(getHealthCheckProgress()).toMatchObject({ running: false, total: 0, checked: 0 });
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

    // 第一次全量读取（config+health+pool）+ 第二次失效检查（批量 findMany 或 3 findFirst）
    expect(mockFindFirst.mock.calls.length + mockFindMany.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(mockFindFirst.mock.calls[0][0].select).toHaveProperty("value");
    // 失效检查 select 同样只取 value（内容比较：同秒双保存下 updatedAt 区分不了）
    // 兼容 findMany 批量校验（无 updatedAt）与 findFirst 校验
    const hasValueCheck = mockFindMany.mock.calls.length > 0 || mockFindFirst.mock.calls.some((c:any)=>c[0]?.select?.value);
    expect(hasValueCheck).toBe(true);
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
    // 第一次全量读取配置 + 第二次失效检查（行缺失时 value 归一到 null
    // 与缓存一致，短路命中不再全量读）；批量优化后第二次为 findMany 单次或 1 次 findFirst
    const totalCalls = mockFindFirst.mock.calls.length + mockFindMany.mock.calls.length;
    expect(totalCalls).toBeGreaterThanOrEqual(2);
    expect(totalCalls).toBeLessThanOrEqual(4);
    const hasValue = mockFindFirst.mock.calls.some((c:any)=>c[0]?.select?.value) || mockFindMany.mock.calls.length>0;
    expect(hasValue).toBe(true);
  });

  it("数据库读取失败 → 返回 null 不抛错", async () => {
    const { getUpstreamProxy } = await loadModule();
    mockFindFirst.mockRejectedValue(new Error("db down"));

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.dispatcher).toBeNull();
    expect(result.url).toBeNull();
  });

  it("同秒双保存：pool/health 的 value 变化而 updatedAt 不变 → 失效检查以内容为信号强制重载", async () => {
    const POOL_KEY = "system:upstream_proxy_pool";
    const URL_A = "http://127.0.0.1:7890";
    const URL_B = "http://127.0.0.1:7891";
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ groups: [{ name: "g1", urls: [URL_A, URL_B] }], platformIds: [] }),
        updatedAt: 1000,
      },
      [POOL_KEY]: { value: JSON.stringify({ g1: [URL_A] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    // 首次全量读取建立缓存
    expect((await getUpstreamProxy(mockDb, mockEnv)).url).toBe(URL_A);

    // 模拟同秒双保存（cron 拉取/健康检查每批与上一次写入同秒完成）：
    // value 已变化但 updatedAt 保持同秒不变（秒级时间戳无法区分内容变化）
    dbRows[POOL_KEY] = { value: JSON.stringify({ g1: [URL_A, URL_B] }), updatedAt: 1000 };
    dbRows[HEALTH_KEY] = {
      value: JSON.stringify({ [URL_B]: { status: "fail", latencyMs: 0, checkedAt: 1000, failCount: 1 } }),
      updatedAt: 1000,
    };

    // TTL 内读取：必须以 value 为失效信号重读——pool 新增了 URL_B（否则路由
    // 永远看不到新代理），health 标记 URL_B fail（否则 fail 代理仍参与轮询）
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const r = await getUpstreamProxy(mockDb, mockEnv);
      if (r.url) seen.add(r.url);
    }
    expect(seen).toEqual(new Set([URL_A]));
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

describe("组启用开关", () => {
  const URL_A = "http://127.0.0.1:7890";
  const URL_B = "http://127.0.0.1:7891";
  const SRC = "https://example.com/proxies.txt";

  function configWith(groups: any[]) {
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ groups, platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
  }

  it("缺省（无 enabled 字段）视为启用", async () => {
    const { getUpstreamProxy } = await loadModule();
    configWith([{ name: "g1", urls: [URL_A] }]);

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.url).toBe(URL_A);
  });

  it("禁用组不参与请求路由（返回直连）", async () => {
    const { getUpstreamProxy } = await loadModule();
    configWith([{ name: "g1", urls: [URL_A], enabled: false }]);

    const result = await getUpstreamProxy(mockDb, mockEnv);

    expect(result.url).toBeNull();
    expect(result.dispatcher).toBeNull();
  });

  it("禁用组不参与拉取（仅拉取启用组的源）", async () => {
    const { pullProxyGroups } = await loadModule();
    configWith([
      { name: "g1", sourceUrl: SRC, enabled: false },
      { name: "g2", sourceUrl: "https://other.example/proxies.txt", enabled: true },
    ]);
    const fetchMock = vi.fn(async (_input: any) => ({ ok: true, status: 200, text: async () => URL_B }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await pullProxyGroups(mockDb, mockEnv);

    // 仅 g2 被拉取（1 次 fetch），g1 不在结果中
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://other.example/proxies.txt");
    expect(results.g1).toBeUndefined();
    expect(results.g2).toMatchObject({ added: 1 });
  });

  it("禁用组不参与健康检查（仅检查启用组的候选）", async () => {
    const { runProxyHealthCheck } = await loadModule();
    configWith([
      { name: "g1", urls: [URL_A], enabled: false },
      { name: "g2", urls: [URL_B], enabled: true },
    ]);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    // 只探测 g2 的候选，g1 的代理不被探测
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual({ [URL_B]: expect.any(Object) });
    expect(results[URL_A]).toBeUndefined();
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

  it("拉取解析：裸 host:port 补全、协议头保留（含 socks4/socks5）、脏行与重复忽略", async () => {
    const { pullProxyGroups } = await loadModule();
    configWith([{ name: "g1", sourceUrl: SRC }]);
    stubFetch(
      "127.0.0.1:7890\nhttp://127.0.0.1:7891\nsocks5://127.0.0.1:1080\n\n# comment\nhttp://127.0.0.1:7890"
    );

    const results = await pullProxyGroups(mockDb, mockEnv);

    expect(results.g1).toMatchObject({ added: 3, removed: 0, kept: 0, total: 3 });
    const upsertArgs = lastUpsertFor(POOL_KEY);
    const pool = JSON.parse(upsertArgs.create.value) as Record<string, any>;
    expect(pool.g1).toEqual(["http://127.0.0.1:7890", "http://127.0.0.1:7891", "socks5://127.0.0.1:1080"]);
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
    // 达阈值：A 进入进程内黑名单（markProxyFailure 第 3 次写健康表 failCount=3）
    for (let i = 0; i < 3; i++) {
      await markProxyFailure(mockDb, mockEnv, URL_A);
    }
    // 拉取返回同一代理 → 交集
    stubFetch(URL_A);

    await pullProxyGroups(mockDb, mockEnv);

    const health = JSON.parse(lastUpsertFor(HEALTH_KEY).create.value) as Record<string, any>;
    // 健康度保留（failCount 为 markProxyFailure 已提交的 3——写锁内重读拿到
    // 最新已落库状态，而非预置行的 5），status 切换为 ok 恢复在池
    expect(health[URL_A]).toMatchObject({ status: "ok", failCount: 3 });
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
    expect(results.g1.added).toBe(0);
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
    // 失败路径不再重写健康表（此前会无条件写一份未变化副本，徒增健康行写压力）：
    // fail 记录原样留在库中，不误恢复
    const healthUpserts = mockUpsert.mock.calls.filter((c) => c[0].where.key === HEALTH_KEY);
    expect(healthUpserts).toHaveLength(0);
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
    expect(results.g1.added).toBe(0);
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

describe("健康表并发写串行化（TiDB 1205 锁等待回归）", () => {
  const URL_A = "http://127.0.0.1:7890";
  const URL_B = "http://127.0.0.1:7891";
  const URL_X = "http://127.0.0.1:9999";
  const POOL_KEY = "system:upstream_proxy_pool";
  const SRC = "https://example.com/proxies.txt";

  it("两代理同时达失败阈值：标记写库串行化，两个 fail 条目都不丢失", async () => {
    const { markProxyFailure } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: [URL_A, URL_B], platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });

    await Promise.all([
      ...[0, 1, 2].map(() => markProxyFailure(mockDb, mockEnv, URL_A)),
      ...[0, 1, 2].map(() => markProxyFailure(mockDb, mockEnv, URL_B)),
    ]);

    // 各达阈值一次 → 恰好 2 次健康表写入（此前并发 upsert 同一行会行锁排队
    // 1205），后写者基于最新表状态合并（此前整表覆盖会丢另一个代理的条目）
    const healthCalls = mockUpsert.mock.calls.filter((c) => c[0].where.key === HEALTH_KEY);
    expect(healthCalls).toHaveLength(2);
    const written = JSON.parse(healthCalls[1][0].create.value) as Record<string, any>;
    expect(written[URL_A]).toMatchObject({ status: "fail", failCount: 3 });
    expect(written[URL_B]).toMatchObject({ status: "fail", failCount: 3 });
  });

  it("健康检查批写入保留并发失败标记的条目（不整表覆盖）", async () => {
    const { runProxyHealthCheck, markProxyFailure, getProxyHealth } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: [URL_A], platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 204 })));

    // 先启动健康检查（批写入须等探测完成才入锁），期间同步触发失败标记：
    // markProxyFailure 的写先入链，健康检查批写后入链且只覆盖已检查的 URL，
    // 候选列表之外的 fail 条目原样保留（此前合并以运行开始快照兜底会丢它）
    const checkPromise = runProxyHealthCheck(mockDb, mockEnv);
    for (let i = 0; i < 3; i++) {
      await markProxyFailure(mockDb, mockEnv, URL_X);
    }
    await checkPromise;

    const { results } = await getProxyHealth(mockDb, mockEnv);
    expect(results[URL_A]).toMatchObject({ status: "ok" });
    expect(results[URL_X]).toMatchObject({ status: "fail", failCount: 3 });
  });

  it("并发拉取单飞：复用进行中的任务，不重复请求源、不双写 pool", async () => {
    const { pullProxyGroups } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }),
        updatedAt: 1000,
      },
      [POOL_KEY]: { value: JSON.stringify({ g1: [URL_A] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 0));
        return { ok: true, status: 200, text: async () => URL_A };
      })
    );

    const [r1, r2] = await Promise.all([
      pullProxyGroups(mockDb, mockEnv),
      pullProxyGroups(mockDb, mockEnv),
    ]);

    expect(r1).toEqual(r2);
    expect(fetchCount).toBe(1);
    // pool + 健康表（交集恢复 ok）+ 拉取时刻记录各恰一次写——并发双拉取曾双写 pool 行
    expect(mockUpsert).toHaveBeenCalledTimes(3);
  });

  it("手动拉取不被进行中的定时拉取吞掉（单飞按模式分开）", async () => {
    const { pullProxyGroups } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }),
        updatedAt: 1000,
      },
      [POOL_KEY]: { value: JSON.stringify({ g1: [URL_A] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    // 首个源请求挂起在 gate 上，锁定「定时拉取进行中」窗口
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => { resolveGate = r; });
    let startedResolve!: () => void;
    const started = new Promise<void>((r) => { startedResolve = r; });
    let fetchCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: any) => {
        if (fetchCount++ === 0) {
          startedResolve(); // 定时拉取已发起源请求 = pullInFlight 已赋值
          await gate;
        }
        return { ok: true, status: 200, text: async () => URL_A };
      })
    );

    const autoP = pullProxyGroups(mockDb, mockEnv); // 定时模式先行
    // 确定性等待定时拉取进入源请求（非轮询：started 是即时信号）
    await started;
    const manualP = pullProxyGroups(mockDb, mockEnv, { manual: true });
    resolveGate();
    const [autoResult, manualResult] = await Promise.all([autoP, manualP]);

    expect(autoResult.g1).toEqual({ total: 1, added: 0, removed: 0, kept: 1 });
    expect(manualResult.g1).toEqual({ total: 1, added: 0, removed: 0, kept: 1 });
    // 两个模式各自发起源请求（此前手动拉取会复用定时任务、退化为只拉「到期组」）
    expect(fetchCount).toBe(2);
  });

  it("健康表写失败后串行链继续：后续写不受阻，失败写不污染缓存", async () => {
    const { markProxyFailure, getProxyHealth } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: [URL_A], platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify({}), updatedAt: 1000 },
    });
    // 第一次健康表写失败（模拟瞬态 DB 错误），后续写恢复
    mockUpsert.mockImplementationOnce(async (args: any) => {
      if (args?.where?.key === HEALTH_KEY) throw new Error("db hiccup");
      return {};
    });

    // 达阈值的那次写失败被吞掉记日志，调用方不抛
    for (let i = 0; i < 3; i++) {
      await expect(markProxyFailure(mockDb, mockEnv, URL_A)).resolves.toBeUndefined();
    }
    // 失败写未落库也未污染缓存：URL_A 的 fail 记录不存在（幻影修改不会在
    // 下一次成功写时被持久化——锁内深拷贝，写失败时缓存保持已提交状态）
    const afterFail = await getProxyHealth(mockDb, mockEnv);
    expect(afterFail.results[URL_A]).toBeUndefined();

    // 串行链未卡死：新代理达阈值 → 写入成功且基于最新表状态合并
    for (let i = 0; i < 3; i++) {
      await markProxyFailure(mockDb, mockEnv, URL_B);
    }
    const { results } = await getProxyHealth(mockDb, mockEnv);
    expect(results[URL_B]).toMatchObject({ status: "fail", failCount: 3 });
    expect(results[URL_A]).toBeUndefined();
  });

  it("拉取健康合并保留并发失败标记的条目（锁内只改交集/移除）", async () => {
    const { pullProxyGroups, markProxyFailure, getProxyHealth } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }),
        updatedAt: 1000,
      },
      [POOL_KEY]: { value: JSON.stringify({ g1: [URL_A] }), updatedAt: 1000 },
      [HEALTH_KEY]: {
        value: JSON.stringify({ [URL_A]: { status: "fail", latencyMs: 0, checkedAt: 1000, failCount: 2 } }),
        updatedAt: 1000,
      },
    });
    // 与拉取无关的 URL_X 进入失败黑名单并落库（与健康检查用例对称：拉取锁内
    // 合并只改交集/移除，候选之外的 fail 条目必须原样保留）
    for (let i = 0; i < 3; i++) {
      await markProxyFailure(mockDb, mockEnv, URL_X);
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, text: async () => URL_A }))
    );

    await pullProxyGroups(mockDb, mockEnv);

    const { results } = await getProxyHealth(mockDb, mockEnv);
    expect(results[URL_A]).toMatchObject({ status: "ok", failCount: 2 });
    expect(results[URL_X]).toMatchObject({ status: "fail", failCount: 3 });
  });
});

describe("组级自动更新（autoRefresh / refreshIntervalMin / 周期判定）", () => {
  const URL_A = "http://127.0.0.1:7890";
  const SRC = "https://example.com/proxies.txt";
  const PULL_AT_KEY = "system:upstream_proxy_pull_at";
  const nowSec = () => Math.floor(Date.now() / 1000);

  it("缺省（无 autoRefresh/refreshIntervalMin 字段）→ 视为启用、默认周期 60：首次拉取全部到期", async () => {
    const { pullProxyGroups } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }), updatedAt: 1000 },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => URL_A }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await pullProxyGroups(mockDb, mockEnv);

    // 无拉取记录：lastAt=0 视为长期未拉，全部到期
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.g1).toMatchObject({ added: 1 });
  });

  it("未到期组（距上次成功拉取 < 周期）定时模式跳过，不发起拉取", async () => {
    const { pullProxyGroups } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }), updatedAt: 1000 },
      [PULL_AT_KEY]: { value: JSON.stringify({ g1: nowSec() - 30 }), updatedAt: 1000 },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => URL_A }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await pullProxyGroups(mockDb, mockEnv);

    // 默认周期 60 分钟：30 秒前刚拉过 → 未到期，整轮跳过不写库
    expect(fetchMock).not.toHaveBeenCalled();
    expect(results).toEqual({});
  });

  it("到期组（距上次拉取 ≥ 周期）定时模式拉取；自定义周期生效", async () => {
    const { pullProxyGroups } = await loadModule();
    // 周期 20160 分钟（14 天）的最长边界：2 小时前拉过 → 未到期（断言长周期生效）
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC, refreshIntervalMin: 20160 }], platformIds: [] }),
        updatedAt: 1000,
      },
      [PULL_AT_KEY]: { value: JSON.stringify({ g1: nowSec() - 7200 }), updatedAt: 1000 },
    });
    let fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => URL_A }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await pullProxyGroups(mockDb, mockEnv)).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();

    // 同样 2 小时前拉过但周期 60 → 已到期拉取
    vi.resetModules();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC, refreshIntervalMin: 60 }], platformIds: [] }),
        updatedAt: 1000,
      },
      [PULL_AT_KEY]: { value: JSON.stringify({ g1: nowSec() - 7200 }), updatedAt: 1000 },
    });
    const fresh = await import("../upstream-proxy");
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => URL_A }));
    vi.stubGlobal("fetch", fetchMock);
    const results = await fresh.pullProxyGroups(mockDb, mockEnv);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.g1).toMatchObject({ added: 1 });
  });

  it("越界/非法周期回退默认 60（0、负数、超上限、小数）", async () => {
    const { pullProxyGroups } = await loadModule();
    // 非法周期 0 回退 60：30 秒前拉过 → 未到期（若按 0 分钟周期会立即重拉）
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC, refreshIntervalMin: 0 }], platformIds: [] }),
        updatedAt: 1000,
      },
      [PULL_AT_KEY]: { value: JSON.stringify({ g1: nowSec() - 30 }), updatedAt: 1000 },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => URL_A }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await pullProxyGroups(mockDb, mockEnv)).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("autoRefresh=false：定时模式跳过（禁用自动更新），手动模式仍立即拉取", async () => {
    const { pullProxyGroups } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC, autoRefresh: false }], platformIds: [] }),
        updatedAt: 1000,
      },
      [PULL_AT_KEY]: { value: JSON.stringify({ g1: nowSec() - 7200 }), updatedAt: 1000 },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => URL_A }));
    vi.stubGlobal("fetch", fetchMock);

    // 定时模式：即使已到期也不拉（自动更新关闭）
    expect(await pullProxyGroups(mockDb, mockEnv)).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();

    // 手动模式：忽略 autoRefresh 与周期，立即拉取
    const results = await pullProxyGroups(mockDb, mockEnv, { manual: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.g1).toMatchObject({ added: 1 });
  });

  it("拉取成功后记录时刻（手动与定时共用：手动拉取后定时周期重新计时），失败不记录", async () => {
    const { pullProxyGroups } = await loadModule();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }), updatedAt: 1000 },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => URL_A }));
    vi.stubGlobal("fetch", fetchMock);

    await pullProxyGroups(mockDb, mockEnv, { manual: true });

    // 成功：PULL_AT_KEY 行记录该组时刻（≈ 当前秒），此后定时模式未到期
    const row = dbRows[PULL_AT_KEY];
    expect(row?.value).toBeDefined();
    const record = JSON.parse(row!.value) as Record<string, number>;
    expect(record.g1).toBeGreaterThan(nowSec() - 5);
    const fetchMock2 = vi.fn(async () => ({ ok: true, status: 200, text: async () => URL_A }));
    vi.stubGlobal("fetch", fetchMock2);
    expect(await pullProxyGroups(mockDb, mockEnv)).toEqual({});
    expect(fetchMock2).not.toHaveBeenCalled();

    // 失败：不记录时刻（定时任务按周期重试）
    vi.resetModules();
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ groups: [{ name: "g1", sourceUrl: SRC }], platformIds: [] }), updatedAt: 1000 },
    });
    const fresh = await import("../upstream-proxy");
    const failFetch = vi.fn(async () => { throw new Error("network down"); });
    vi.stubGlobal("fetch", failFetch);
    const failed = await fresh.pullProxyGroups(mockDb, mockEnv);
    expect(failed.g1.error).toBeDefined();
    expect(dbRows[PULL_AT_KEY]).toBeUndefined();
  });
});

describe("健康检查响应体消费（崩溃回归）", () => {
  const URL_A = "http://127.0.0.1:7890";
  const CHECK_URL = "https://cp.cloudflare.com/generate_204";

  function configWith(urls: string[]) {
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls, platformIds: [], healthCheckUrl: CHECK_URL }),
        updatedAt: 1000,
      },
    });
  }

  it("探测响应 body 必须被读取——未消费 body 挂起 undici keep-alive 连接，每轮泄漏一个连接导致 fd/内存耗尽进程崩溃", async () => {
    const { runProxyHealthCheck } = await loadModule();
    configWith([URL_A]);
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    expect(results[URL_A]).toMatchObject({ status: "ok" });
    // 真实 Response：body 已被消费（bodyUsed=true，连接归还 keep-alive 池）
    const response = (await fetchMock.mock.results[0].value) as Response;
    expect(response.bodyUsed).toBe(true);
  });

  it("探测失败响应同样消费 body（错误路径不泄漏连接）", async () => {
    const { runProxyHealthCheck } = await loadModule();
    configWith([URL_A]);
    const fetchMock = vi.fn(async () => new Response("error page", { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await runProxyHealthCheck(mockDb, mockEnv);

    expect(results[URL_A]).toMatchObject({ status: "fail" });
    const response = (await fetchMock.mock.results[0].value) as Response;
    expect(response.bodyUsed).toBe(true);
  });
});

describe("业务流量统计与路由降权", () => {
  const URL_A = "http://127.0.0.1:7890";
  const URL_B = "http://127.0.0.1:7891";

  /** 两个健康（无延迟 → 轮询模式）代理的配置 */
  function configWithTwoHealthy() {
    setConfigRows({
      [CONFIG_KEY]: {
        value: JSON.stringify({ urls: [URL_A, URL_B], platformIds: [] }),
        updatedAt: 1000,
      },
    });
  }

  it("isProxyStatDegraded：样本<5 不降权；错误率>0.8 降权（含 errOther）；窗口过期自动恢复", async () => {
    const { isProxyStatDegraded } = await loadModule();
    const now = Date.now();
    // 样本不足（即使全错）不降权
    expect(isProxyStatDegraded({ total: 4, ok: 0, err429: 4, errOther: 0, firstAt: now, lastAt: now })).toBe(false);
    // 错误率 5/6 > 0.8 → 降权（429 计入错误）
    expect(isProxyStatDegraded({ total: 6, ok: 1, err429: 5, errOther: 0, firstAt: now, lastAt: now })).toBe(true);
    // errOther（网络层失败 status=0 / 非 429 错误）同样计入错误
    expect(isProxyStatDegraded({ total: 5, ok: 0, err429: 0, errOther: 5, firstAt: now, lastAt: now })).toBe(true);
    // 错误率 4/6 ≈ 0.667 ≤ 0.8 → 不降权
    expect(isProxyStatDegraded({ total: 6, ok: 2, err429: 4, errOther: 0, firstAt: now, lastAt: now })).toBe(false);
    // 边界：恰好 0.8（4/5）不降权（严格大于才降权）
    expect(isProxyStatDegraded({ total: 5, ok: 1, err429: 4, errOther: 0, firstAt: now, lastAt: now })).toBe(false);
    // 窗口滑动（lastAt 超过 10 分钟）→ 自动恢复
    expect(isProxyStatDegraded({ total: 5, ok: 0, err429: 5, errOther: 0, firstAt: now - 11 * 60_000, lastAt: now - 11 * 60_000 })).toBe(false);
  });

  it("recordProxyTraffic 分类：429 计入错误 / 200 计入成功，错误率超阈值的代理被路由跳过", async () => {
    const { getUpstreamProxy, recordProxyTraffic } = await loadModule();
    configWithTwoHealthy();
    // A：6 次请求 5 次 429（错误率 5/6 > 0.8 → 降权）
    for (let i = 0; i < 5; i++) recordProxyTraffic(URL_A, 429);
    recordProxyTraffic(URL_A, 200);
    // B：6 次请求 2 次 429（错误率 1/3 ≤ 0.8 → 正常；证明 200 计入成功）
    for (let i = 0; i < 2; i++) recordProxyTraffic(URL_B, 429);
    for (let i = 0; i < 4; i++) recordProxyTraffic(URL_B, 200);

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.url).toBe(URL_B);
    expect(second.url).toBe(URL_B);
  });

  it("recordProxyTraffic 跨窗口重置：窗口过期后计数归零，旧错误基数不继续推高错误率", async () => {
    const { getUpstreamProxy, recordProxyTraffic } = await loadModule();
    configWithTwoHealthy();
    vi.useFakeTimers();
    try {
      // 窗口内 A 达降权阈值（5/5 全错）→ 路由只选 B
      for (let i = 0; i < 5; i++) recordProxyTraffic(URL_A, 429);
      const result = await getUpstreamProxy(mockDb, mockEnv);
      expect(result.url).toBe(URL_B);

      // 窗口滑动（11 分钟）后 A 新来 1 成功 + 4 次 429：重置后错误率恰为
      // 0.8（严格大于才降权 → 不降权）；若未重置则为 9/10 = 0.9（降权）——
      // 该用例可区分两种实现
      vi.setSystemTime(Date.now() + 11 * 60_000);
      recordProxyTraffic(URL_A, 200);
      for (let i = 0; i < 4; i++) recordProxyTraffic(URL_A, 429);
      // A 恢复为候选但成功率仅 0.2 → 可用性档位 0.5（B 无统计中性 2），
      // 平滑加权轮询按权重比例 1:4 分配：5 次序列 B B A B B（A 占 1/5
      // = 20%，仅分少量请求而非与健康代理均分——此前的轮询平均分配）
      const picks: Array<string | null> = [];
      for (let i = 0; i < 5; i++) {
        picks.push((await getUpstreamProxy(mockDb, mockEnv)).url);
      }
      expect(picks).toEqual([URL_B, URL_B, URL_A, URL_B, URL_B]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recordProxyTraffic 真滑窗：持续请求下窗口起点固定，滑过即整体重置（断流重置实现不重置）", async () => {
    const { getUpstreamProxy, recordProxyTraffic } = await loadModule();
    configWithTwoHealthy();
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      // 窗口内 A 达降权阈值（5/5 全错）→ 路由只选 B
      for (let i = 0; i < 5; i++) recordProxyTraffic(URL_A, 429);
      expect((await getUpstreamProxy(mockDb, mockEnv)).url).toBe(URL_B);

      // 持续请求不断流：第 1~9 分钟各 1 次 429（错误基数持续累积，lastAt 始终新鲜）
      for (let m = 1; m <= 9; m++) {
        vi.setSystemTime(t0 + m * 60_000);
        recordProxyTraffic(URL_A, 429);
      }
      // 第 11 分钟（窗口滑过 firstAt + 10 分钟）1 次成功：真滑窗整体重置后
      // 错误率只反映本次成功（样本不足不降权、可用性未知中性 → A 恢复候选
      // 且与 B 均等权重）；断流重置实现下 lastAt 持续新鲜 → 计数不重置仍
      // 14/14 全错（降权）——该用例可区分两种实现。均等权重下平滑加权轮询
      // 退化为轮询：先 A（tie 取先出现）后 B
      vi.setSystemTime(t0 + 11 * 60_000);
      recordProxyTraffic(URL_A, 200);
      const r1 = await getUpstreamProxy(mockDb, mockEnv);
      const r2 = await getUpstreamProxy(mockDb, mockEnv);
      expect([r1.url, r2.url]).toEqual([URL_A, URL_B]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getDegradedProxyUrls：仅返回窗口内错误率超阈值的代理（样本不足/正常/跨窗口恢复均排除）", async () => {
    const { getDegradedProxyUrls, recordProxyTraffic } = await loadModule();
    // 无统计 → 空
    expect(getDegradedProxyUrls()).toEqual([]);
    // 样本不足（4 次全错）→ 不降权
    for (let i = 0; i < 4; i++) recordProxyTraffic(URL_A, 429);
    expect(getDegradedProxyUrls()).toEqual([]);
    // 达阈值（5/5 全错）→ 降权
    recordProxyTraffic(URL_A, 429);
    expect(getDegradedProxyUrls()).toEqual([URL_A]);
    // 正常代理（200 为主）不计入
    for (let i = 0; i < 4; i++) recordProxyTraffic(URL_B, 200);
    expect(getDegradedProxyUrls()).toEqual([URL_A]);
  });

  it("recordProxyTraffic 忽略空地址（直连请求不产生统计条目）", async () => {
    const { getUpstreamProxy, recordProxyTraffic } = await loadModule();
    configWithTwoHealthy();
    // 直连（undefined）不记统计；也验证不抛错
    recordProxyTraffic(undefined, 200);
    recordProxyTraffic("", 500);

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);

    // 无统计条目 → 保持原轮询行为
    expect([first.url, second.url]).toEqual([URL_A, URL_B]);
  });

  it("全部候选统计降权 → 回退全部代理轮询（不改变走代理语义）", async () => {
    const { getUpstreamProxy, recordProxyTraffic } = await loadModule();
    configWithTwoHealthy();
    for (let i = 0; i < 5; i++) {
      recordProxyTraffic(URL_A, 429);
      recordProxyTraffic(URL_B, 429);
    }

    const first = await getUpstreamProxy(mockDb, mockEnv);
    const second = await getUpstreamProxy(mockDb, mockEnv);

    expect(first.url).toBe(URL_A);
    expect(second.url).toBe(URL_B);
  });
});

describe("可用性×延迟加权选择", () => {
  const URL_A = "http://127.0.0.1:7890";
  const URL_B = "http://127.0.0.1:7891";

  function configWith(urls: string[], health: Record<string, unknown>) {
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls, platformIds: [] }), updatedAt: 1000 },
      [HEALTH_KEY]: { value: JSON.stringify(health), updatedAt: 1000 },
    });
  }

  it("availabilityWeight 档位：成功率越高权重越大，样本不足中性，接近排除线仅极小份额", async () => {
    const { availabilityWeight } = await loadModule();
    const now = Date.now();
    const stat = (ok: number, err: number) => ({
      total: ok + err,
      ok,
      err429: err,
      errOther: 0,
      firstAt: now,
      lastAt: now,
    });
    // 无统计 / 样本不足（total < 5）→ 中性档 2
    expect(availabilityWeight(undefined)).toBe(2);
    expect(availabilityWeight(stat(4, 0))).toBe(2);
    // 成功率档位边界（0.9/0.7/0.5/0.3/0.2 含边界值）
    expect(availabilityWeight(stat(5, 0))).toBe(8); // 1.0
    expect(availabilityWeight(stat(9, 1))).toBe(8); // 0.9
    expect(availabilityWeight(stat(8, 2))).toBe(4); // 0.8
    expect(availabilityWeight(stat(7, 3))).toBe(4); // 0.7
    expect(availabilityWeight(stat(6, 4))).toBe(2); // 0.6
    expect(availabilityWeight(stat(5, 5))).toBe(2); // 0.5
    expect(availabilityWeight(stat(4, 6))).toBe(1); // 0.4
    expect(availabilityWeight(stat(3, 7))).toBe(1); // 0.3
    expect(availabilityWeight(stat(2, 8))).toBe(0.5); // 0.2
    expect(availabilityWeight(stat(1, 9))).toBe(0.2); // 0.1
    expect(availabilityWeight(stat(0, 5))).toBe(0.2); // 0（降权排除线边缘）
  });

  it("latencyWeight：最快 ×1.25 / 最慢下探 0.75 / 未知或组内无已知延迟 ×1", async () => {
    const { latencyWeight } = await loadModule();
    expect(latencyWeight(100, 100)).toBe(1.25); // 最快（= 组内最小延迟）
    expect(latencyWeight(200, 100)).toBe(1); // 2 倍延迟
    expect(latencyWeight(400, 100)).toBe(0.875); // 4 倍延迟
    expect(latencyWeight(1000, 100)).toBe(0.8); // 10 倍延迟（极端值压向 0.75 下限）
    expect(latencyWeight(0, 100)).toBe(1); // 延迟未知
    expect(latencyWeight(100, 0)).toBe(1); // 组内无已知延迟
  });

  it("可用性主导：持续 429（错误率超阈值）的代理即使延迟最低也完全不被选中", async () => {
    const { getUpstreamProxy, recordProxyTraffic } = await loadModule();
    // A 延迟 10ms（组内最低）但 5/5 全 429 → 降权排除；B 延迟 500ms 正常
    configWith([URL_A, URL_B], {
      [URL_A]: { status: "ok", latencyMs: 10, checkedAt: 1000, failCount: 0 },
      [URL_B]: { status: "ok", latencyMs: 500, checkedAt: 1000, failCount: 0 },
    });
    for (let i = 0; i < 5; i++) recordProxyTraffic(URL_A, 429);

    // 6 次连续选择全部落在 B（此前的延迟最优选择会固定打向 10ms 的 A）
    for (let i = 0; i < 6; i++) {
      expect((await getUpstreamProxy(mockDb, mockEnv)).url).toBe(URL_B);
    }
  });

  it("按权重比例分配：成功率 100% 的代理拿 4/5 请求，50% 的代理分得 1/5", async () => {
    const { getUpstreamProxy, recordProxyTraffic } = await loadModule();
    configWith([URL_A, URL_B], {
      [URL_A]: { status: "ok", latencyMs: 50, checkedAt: 1000, failCount: 0 },
      [URL_B]: { status: "ok", latencyMs: 50, checkedAt: 1000, failCount: 0 },
    });
    // A 全成功（权重 8×1.25 = 10）；B 一半成功（权重 2×1.25 = 2.5）→ 4:1
    for (let i = 0; i < 5; i++) recordProxyTraffic(URL_A, 200);
    for (let i = 0; i < 3; i++) recordProxyTraffic(URL_B, 200);
    for (let i = 0; i < 3; i++) recordProxyTraffic(URL_B, 429);

    // 平滑加权轮询 5 次序列 A A B A A：B 占 1/5 = 20% 与权重比例一致；
    // 高权重代理分得多但不连续独占（无 AAA 连击）
    const picks: Array<string | null> = [];
    for (let i = 0; i < 5; i++) {
      picks.push((await getUpstreamProxy(mockDb, mockEnv)).url);
    }
    expect(picks).toEqual([URL_A, URL_A, URL_B, URL_A, URL_A]);
  });

  it("接近排除线的代理（错误率 0.8 不排除）仅分少量请求，健康代理占绝对多数", async () => {
    const { getUpstreamProxy, recordProxyTraffic } = await loadModule();
    // A 成功率 0.2（权重 0.5×1.25 = 0.625，错误率恰 0.8 不降权）；
    // B 成功率 1.0 但延迟 4 倍（权重 8×0.875 = 7）——可用性主导仍占多数
    configWith([URL_A, URL_B], {
      [URL_A]: { status: "ok", latencyMs: 50, checkedAt: 1000, failCount: 0 },
      [URL_B]: { status: "ok", latencyMs: 200, checkedAt: 1000, failCount: 0 },
    });
    recordProxyTraffic(URL_A, 200);
    for (let i = 0; i < 4; i++) recordProxyTraffic(URL_A, 429);
    for (let i = 0; i < 5; i++) recordProxyTraffic(URL_B, 200);

    const counts: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      const url = (await getUpstreamProxy(mockDb, mockEnv)).url as string;
      counts[url] = (counts[url] ?? 0) + 1;
    }
    // 权重比 0.625:7 ≈ 1:11.2：10 次中 A 恰 1 次（约 10%，保持少量份额不饿死）
    expect(counts[URL_A]).toBe(1);
    expect(counts[URL_B]).toBe(9);
  });
});

describe("健康检查间隔配置（healthCheckIntervalMin）", () => {
  /** 注入配置后加载一次模块，返回 getUpstreamProxy 后的最新缓存值 */
  async function intervalAfterLoad(
    value: unknown,
    raw?: string
  ): Promise<number> {
    vi.resetModules();
    const mod = await import("../upstream-proxy");
    setConfigRows({
      [CONFIG_KEY]: {
        value:
          raw ??
          JSON.stringify({ urls: ["http://127.0.0.1:7890"], ...(value !== undefined ? { healthCheckIntervalMin: value } : {}) }),
        updatedAt: 1000,
      },
    });
    await mod.getUpstreamProxy(mockDb, mockEnv);
    return mod.getHealthCheckIntervalMin();
  }

  it("合法间隔（10）→ 缓存生效，调度器读取配置值", async () => {
    expect(await intervalAfterLoad(10)).toBe(10);
  });

  it("缺省（无字段）→ 默认 5", async () => {
    expect(await intervalAfterLoad(undefined)).toBe(5);
  });

  it("越界/非法值回退默认 5（0、1441、小数、字符串、null）", async () => {
    for (const bad of [0, 1441, 2.5, "10", null]) {
      expect(await intervalAfterLoad(bad)).toBe(5);
    }
  });

  it("边界值 1 与上限 1440（24 小时）均合法", async () => {
    expect(await intervalAfterLoad(1)).toBe(1);
    expect(await intervalAfterLoad(1440)).toBe(1440);
  });

  it("无代理配置（{} / 纯 URL 旧格式）→ 默认 5，不抛错", async () => {
    expect(await intervalAfterLoad(undefined, "{}")).toBe(5);
    expect(await intervalAfterLoad(undefined, "http://127.0.0.1:7890")).toBe(5);
  });
});

describe("环境变量设备级禁用（UPSTREAM_PROXY_DISABLED）", () => {
  const URL_A = "http://127.0.0.1:7890";

  it("getProxyDisableMode：未设置/非法 → null，all/health → 对应值", async () => {
    const { getProxyDisableMode, isUpstreamProxyDisabled, isScheduledProxyHealthDisabled } = await loadModule();
    setProxyDisabled(undefined);
    expect(getProxyDisableMode()).toBeNull();
    expect(isUpstreamProxyDisabled()).toBe(false);
    expect(isScheduledProxyHealthDisabled()).toBe(false);
    setProxyDisabled("all");
    expect(getProxyDisableMode()).toBe("all");
    expect(isUpstreamProxyDisabled()).toBe(true);
    expect(isScheduledProxyHealthDisabled()).toBe(true);
    setProxyDisabled("health");
    expect(getProxyDisableMode()).toBe("health");
    expect(isUpstreamProxyDisabled()).toBe(false);
    expect(isScheduledProxyHealthDisabled()).toBe(true);
    setProxyDisabled("yes");
    expect(getProxyDisableMode()).toBeNull();
    expect(isScheduledProxyHealthDisabled()).toBe(false);
  });

  it("all：业务请求直连——不读配置、不建代理连接", async () => {
    setProxyDisabled("all");
    const { getUpstreamProxy } = await loadModule();
    setConfigRows({ [CONFIG_KEY]: { value: URL_A, updatedAt: 1000 } });
    const result = await getUpstreamProxy(mockDb, mockEnv, "p1");
    expect(result).toEqual({ dispatcher: null, url: null });
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(createdAgents.length).toBe(0);
  });

  it("all：拉取与健康检查（含手动）均不执行，不查库不写库", async () => {
    setProxyDisabled("all");
    const { pullProxyGroups, runProxyHealthCheck, getProxyHealth, getHealthCheckProgress } = await loadModule();
    setConfigRows({ [CONFIG_KEY]: { value: JSON.stringify({ urls: [URL_A] }), updatedAt: 1000 } });
    expect(await pullProxyGroups(mockDb, mockEnv)).toEqual({});
    expect(await runProxyHealthCheck(mockDb, mockEnv)).toEqual({});
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(getHealthCheckProgress().running).toBe(false);
    const health = await getProxyHealth(mockDb, mockEnv);
    expect(health).toEqual({
      results: {},
      progress: { running: false, total: 0, checked: 0, startedAt: 0 },
    });
  });

  it("health：仅定时健康检查禁用；业务请求与手动检查仍正常", async () => {
    setProxyDisabled("health");
    const { isUpstreamProxyDisabled, isScheduledProxyHealthDisabled, getUpstreamProxy, runProxyHealthCheck } =
      await loadModule();
    expect(isUpstreamProxyDisabled()).toBe(false);
    expect(isScheduledProxyHealthDisabled()).toBe(true);
    // 业务请求仍走代理（与未禁用时一致）
    setConfigRows({ [CONFIG_KEY]: { value: URL_A, updatedAt: 1000 } });
    const sel = await getUpstreamProxy(mockDb, mockEnv, "p1");
    expect(sel.url).toBe(URL_A);
    // 手动触发健康检查仍执行：探测并写健康表
    setConfigRows({
      [CONFIG_KEY]: { value: JSON.stringify({ urls: [URL_A], platformIds: [] }), updatedAt: 1000 },
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const results = await runProxyHealthCheck(mockDb, mockEnv);
    expect(results[URL_A]).toMatchObject({ status: "ok", latencyMs: expect.any(Number) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 健康表写一次（锁行 upsert 不在此列）
    const healthUpserts = mockUpsert.mock.calls.filter((c) => c[0].where.key === HEALTH_KEY);
    expect(healthUpserts).toHaveLength(1);
  });
});

describe("normalizeProxyStatKey 统计键归一化（#28）", () => {
  it("去凭据：user:pass 与无凭据的同 host:port 归并为同一键", async () => {
    const { normalizeProxyStatKey } = await loadModule();
    expect(normalizeProxyStatKey("http://127.0.0.1:7890")).toBe("127.0.0.1:7890");
    expect(normalizeProxyStatKey("http://user:pass@127.0.0.1:7890")).toBe("127.0.0.1:7890");
    expect(normalizeProxyStatKey("socks5://user:pass@127.0.0.1:1080")).toBe("127.0.0.1:1080");
  });

  it("兼容历史脱敏键与裸 host:port（maskProxyUrl 产物自动并入新键）", async () => {
    const { normalizeProxyStatKey } = await loadModule();
    // 历史落库键：maskProxyUrl 脱敏后的 ***@host:port（带/不带协议前缀）
    expect(normalizeProxyStatKey("http://***@127.0.0.1:7890")).toBe("127.0.0.1:7890");
    expect(normalizeProxyStatKey("***@127.0.0.1:7890")).toBe("127.0.0.1:7890");
    // 裸 host:port 幂等
    expect(normalizeProxyStatKey("127.0.0.1:7890")).toBe("127.0.0.1:7890");
  });

  it("默认端口按协议归一化：http→80、https→443、socks→1080", async () => {
    const { normalizeProxyStatKey } = await loadModule();
    expect(normalizeProxyStatKey("http://host")).toBe("host:80");
    expect(normalizeProxyStatKey("http://host:80")).toBe("host:80");
    expect(normalizeProxyStatKey("https://host")).toBe("host:443");
    expect(normalizeProxyStatKey("socks5://host")).toBe("host:1080");
    expect(normalizeProxyStatKey("socks4://host")).toBe("host:1080");
  });

  it("IPv6 字面量保留方括号；解析失败回退脱敏（不泄漏凭据）", async () => {
    const { normalizeProxyStatKey } = await loadModule();
    expect(normalizeProxyStatKey("http://[::1]:7890")).toBe("[::1]:7890");
    // 无法解析的畸形地址回退 maskProxyUrl（键稳定且不含凭据）
    expect(normalizeProxyStatKey("not a url with user:pass@")).toBe("not a url with user:pass@");
  });
});

describe("proxyStatKey 代理级统计键（账号独立成键）", () => {
  it("无凭据地址 → 裸 host:port（与历史日志键兼容）", async () => {
    const { proxyStatKey } = await loadModule();
    expect(proxyStatKey("http://127.0.0.1:7890")).toBe("127.0.0.1:7890");
    expect(proxyStatKey("socks5://127.0.0.1:1080")).toBe("127.0.0.1:1080");
    expect(proxyStatKey("http://host")).toBe("host:80");
  });

  it("带凭据地址 → host:port#账号指纹，同 host:port 不同账号独立成键", async () => {
    const { proxyStatKey } = await loadModule();
    const a1 = proxyStatKey("http://user1:pass1@proxy.example.com:8080");
    const a2 = proxyStatKey("http://user2:pass2@proxy.example.com:8080");
    // 同 host:port、账号不同 → 键不同（不再合并统计）
    expect(a1).toBe("proxy.example.com:8080#87c99c34");
    expect(a2).toBe("proxy.example.com:8080#e24df5b4");
    expect(a1).not.toBe(a2);
    // 同一 URL 幂等（指纹稳定可复现）
    expect(proxyStatKey("http://user1:pass1@proxy.example.com:8080")).toBe(a1);
    // 键不含凭据明文
    expect(a1).not.toContain("pass1");
    expect(a2).not.toContain("pass2");
  });

  it("历史脱敏键（***@host:port）→ 裸 host:port（历史数据无法归属具体账号）", async () => {
    const { proxyStatKey } = await loadModule();
    expect(proxyStatKey("http://***@127.0.0.1:7890")).toBe("127.0.0.1:7890");
    expect(proxyStatKey("***@127.0.0.1:7890")).toBe("127.0.0.1:7890");
  });

  it("幂等：对已落库统计键再次调用返回原值（聚合/查表往返不剥离指纹）", async () => {
    const { proxyStatKey } = await loadModule();
    // 落库键（带凭据账号指纹）→ 聚合键 → 前端查表键 三者必须一致：
    // stats 聚合与前端查表都会对已落库键/原始 URL 调用 proxyStatKey，
    // 若 # 后指纹被当 fragment 剥离，带凭据代理统计将查表失配
    const stored = proxyStatKey("http://user1:pass1@proxy.example.com:8080");
    expect(stored).toBe("proxy.example.com:8080#87c99c34");
    expect(proxyStatKey(stored)).toBe(stored);
    expect(proxyStatKey(proxyStatKey(stored))).toBe(stored);
    // 无凭据键往返同样保持原值
    expect(proxyStatKey(proxyStatKey("http://127.0.0.1:7890"))).toBe("127.0.0.1:7890");
  });
});

describe("displayProxyUrl 展示用地址（用户名保留 + 密码打码）", () => {
  async function loadUiModule() {
    return import("../upstream-proxy-ui");
  }

  it("user:pass 凭据 → 用户名保留、密码打码", async () => {
    const { displayProxyUrl } = await loadUiModule();
    expect(displayProxyUrl("http://user1:pass1@proxy.example.com:8080")).toBe(
      "http://user1:***@proxy.example.com:8080"
    );
  });

  it("无凭据地址原样返回（无 @ 可打码）", async () => {
    const { displayProxyUrl } = await loadUiModule();
    expect(displayProxyUrl("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
  });

  it("密码含冒号/特殊字符不泄漏其余片段", async () => {
    const { displayProxyUrl } = await loadUiModule();
    expect(displayProxyUrl("http://user:p:a:ss@proxy.example.com:8080")).toBe(
      "http://user:***@proxy.example.com:8080"
    );
  });
});