/**
 * 日志归档（log-archiver）测试
 *
 * 覆盖 TiDB Cloud Serverless 单次查询硬上限 10000 行场景：
 * 单天日志超过 10000 条时必须分页拉全再按 id 删除，
 * 不能按整天时间范围 deleteMany（否则超出部分会被静默删除而未归档）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(),
}));

/** 构造一条模拟请求日志 */
function makeLog(i: number, dayStartTs: number) {
  return {
    id: `log-${i}`,
    keyId: "key-1",
    keyName: "k1",
    platformId: "plat-1",
    model: "gpt-4o",
    tokens: 10,
    promptTokens: 5,
    completionTokens: 5,
    ttft: 100,
    latency: 200,
    createdAt: dayStartTs,
  };
}

describe("runArchiveTask 归档单天日志", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("单天超过 10000 条时分页拉全并按 id 分批删除（不按整天范围误删）", async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldestTs = now - 31 * 86400;
    const dayStartTs = oldestTs - (oldestTs % 86400);

    // 该天共 10001 条：第 1 页满 10000，第 2 页 1 条
    const findManyArgs: Array<{ take: number; skip?: number }> = [];
    let findManyCalls = 0;
    const archiveDeleteCalls: string[][] = [];

    const { createDb } = await import("@/lib/prisma");
    const mockCreateDb = vi.mocked(createDb);
    const mockPrisma = {
      requestLogs: {
        deleteMany: vi.fn((args: { where: Record<string, unknown> }) => {
          // 异常时间戳清理：where 含 OR
          if ((args.where as any).OR) return Promise.resolve({ count: 0 });
          // 归档删除：where.id.in
          const ids = (args.where.id as { in: string[] }).in;
          archiveDeleteCalls.push(ids);
          return Promise.resolve({ count: ids.length });
        }),
        findFirst: vi.fn(() => Promise.resolve({ createdAt: oldestTs })),
        findMany: vi.fn((args: any) => {
          findManyArgs.push({ take: args.take, skip: args.skip });
          findManyCalls++;
          if (findManyCalls === 1) {
            return Promise.resolve(Array.from({ length: 10000 }, (_, i) => makeLog(i, dayStartTs)));
          }
          if (findManyCalls === 2) {
            return Promise.resolve([makeLog(10000, dayStartTs)]);
          }
          // 后续日期无日志
          return Promise.resolve([]);
        }),
      },
      dailyStats: {
        deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
        findFirst: vi.fn(() => Promise.resolve(null)),
        create: vi.fn(() => Promise.resolve({ id: "ds_1" })),
        createMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
      // 归档互斥锁依赖：findFirst 无锁行 → create 成功即持有
      configs: {
        findFirst: vi.fn(() => Promise.resolve(null)),
        create: vi.fn(() => Promise.resolve({})),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
        deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
      requestDebugLogs: {
        deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
      },
    } as any;
    mockCreateDb.mockResolvedValue(mockPrisma);

    const { runArchiveTask: run } = await import("../log-archiver");
    const result = await run({} as any);

    expect(result.success).toBe(true);
    expect(result.details).toEqual({ datesArchived: 1, logsProcessed: 10001, logsDeleted: 10001 });

    // 分页拉取：游标分页下 skip 为 undefined（用 OR 游标），OFFSET 分页下为 0/10000，均需覆盖全量
    expect(findManyArgs[0].take).toBe(10000);
    expect(findManyArgs[1].take).toBe(10000);
    // 兼容两种分页实现：OFFSET 用 skip，游标用 OR
    const isCursor = findManyArgs[0].skip === undefined;
    if (isCursor) {
      expect(findManyArgs[0].skip).toBeUndefined();
    } else {
      expect(findManyArgs[0]).toEqual({ take: 10000, skip: 0 });
      expect(findManyArgs[1]).toEqual({ take: 10000, skip: 10000 });
    }

    // 删除按 id 分批（DELETE_BATCH=100，D1 绑定参数上限 100）：100×100 / 1
    const expectedBatchLengths = Array.from({ length: 100 }, () => 100);
    expectedBatchLengths.push(1);
    expect(archiveDeleteCalls.map((c) => c.length)).toEqual(expectedBatchLengths);
    const allDeletedIds = archiveDeleteCalls.flat();
    expect(allDeletedIds).toHaveLength(10001);
    expect(allDeletedIds[0]).toBe("log-0");
    expect(allDeletedIds[10000]).toBe("log-10000");

    // 聚合完整：10001 条全部计入 daily_stats（兼容 create 与 createMany 两种实现）
    // 若为 createMany，聚合为单行 createMany({data:[...]})，取首行校验
    let createData: any;
    if ((mockPrisma.dailyStats.createMany as any).mock.calls.length > 0) {
      const args = (mockPrisma.dailyStats.createMany as any).mock.calls[0][0];
      const data = Array.isArray(args.data) ? args.data[0] : args.data;
      createData = data;
      expect((mockPrisma.dailyStats.createMany as any)).toHaveBeenCalled();
    } else {
      const dailyStatsCreate = vi.mocked(mockPrisma.dailyStats.create);
      expect(dailyStatsCreate).toHaveBeenCalledTimes(1);
      createData = dailyStatsCreate.mock.calls[0][0].data;
    }
    expect(createData.totalRequests).toBe(10001);
    expect(createData.totalTokens).toBe(100010);
  });

  it("少于 10000 条时单次拉取并正常归档删除", async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldestTs = now - 31 * 86400;
    const dayStartTs = oldestTs - (oldestTs % 86400);

    const archiveDeleteCalls: string[][] = [];

    const { createDb } = await import("@/lib/prisma");
    const mockCreateDb = vi.mocked(createDb);
    const mockPrisma = {
      requestLogs: {
        deleteMany: vi.fn((args: { where: Record<string, unknown> }) => {
          if ((args.where as any).OR) return Promise.resolve({ count: 0 });
          const ids = (args.where.id as { in: string[] }).in;
          archiveDeleteCalls.push(ids);
          return Promise.resolve({ count: ids.length });
        }),
        findFirst: vi.fn(() => Promise.resolve({ createdAt: oldestTs })),
        findMany: vi.fn((args: any) => {
          // 只有第 1 天（gte === dayStartTs）有日志，后续日期返回空；兼容 skip 与游标 OR
          const isTargetDay = args.where?.createdAt?.gte === dayStartTs;
          const isFirstPage = args.skip === 0 || (args.skip === undefined && !args.where?.OR);
          if (isTargetDay && isFirstPage) {
            // 首次调用返回 3 条，后续游标页返回空
            if (!args.where?.OR) {
              return Promise.resolve([
                makeLog(0, dayStartTs),
                makeLog(1, dayStartTs),
                makeLog(2, dayStartTs),
              ]);
            }
            return Promise.resolve([]);
          }
          if (args.where?.OR && isTargetDay) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      },
      dailyStats: {
        deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
        findFirst: vi.fn(() => Promise.resolve(null)),
        create: vi.fn(() => Promise.resolve({ id: "ds_1" })),
        createMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
      // 归档互斥锁依赖：findFirst 无锁行 → create 成功即持有
      configs: {
        findFirst: vi.fn(() => Promise.resolve(null)),
        create: vi.fn(() => Promise.resolve({})),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
        deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
      requestDebugLogs: {
        deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
      },
    } as any;
    mockCreateDb.mockResolvedValue(mockPrisma);

    const { runArchiveTask: run } = await import("../log-archiver");
    const result = await run({} as any);

    expect(result.success).toBe(true);
    expect(result.details).toEqual({ datesArchived: 1, logsProcessed: 3, logsDeleted: 3 });
    expect(archiveDeleteCalls.map((c) => c.length)).toEqual([3]);
  });

  it("残留日志重跑时清空该天旧聚合后重算（不累加双倍计数）", async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldestTs = now - 31 * 86400;
    const dayStartTs = oldestTs - (oldestTs % 86400);

    const { createDb } = await import("@/lib/prisma");
    const mockCreateDb = vi.mocked(createDb);
    const deleteManyCalls: Array<{ where: Record<string, unknown> }> = [];
    let findManyCalls = 0;
    const mockPrisma = {
      requestLogs: {
        deleteMany: vi.fn((args: { where: Record<string, unknown> }) => {
          if ((args.where as any).OR) return Promise.resolve({ count: 0 });
          return Promise.resolve({ count: 0 });
        }),
        findFirst: vi.fn(() => Promise.resolve({ createdAt: oldestTs })),
        findMany: vi.fn(() => {
          findManyCalls++;
          // call 1: 无 cursor，第一天首次查询 → 残留 2 条
          // call 2+: cursor 或其他天 → 空
          if (findManyCalls === 1) {
            return Promise.resolve([makeLog(3, dayStartTs), makeLog(4, dayStartTs)]);
          }
          return Promise.resolve([]);
        }),
      },
      dailyStats: {
        deleteMany: vi.fn((args: { where: Record<string, unknown> }) => {
          deleteManyCalls.push(args);
          return Promise.resolve({ count: 1 });
        }),
        create: vi.fn(() => Promise.resolve({ id: "ds_new" })),
        createMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
      // 归档互斥锁依赖：findFirst 无锁行 → create 成功即持有
      configs: {
        findFirst: vi.fn(() => Promise.resolve(null)),
        create: vi.fn(() => Promise.resolve({})),
        updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
        deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
      },
      requestDebugLogs: {
        deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
      },
    } as any;
    mockCreateDb.mockResolvedValue(mockPrisma);

    const { runArchiveTask: run } = await import("../log-archiver");
    const result = await run({} as any);

    expect(result.success).toBe(true);

    // 重算语义：先按 date 清空旧聚合（含上次已聚合的 5 条），再以残留日志为准重算
    expect(deleteManyCalls.length).toBe(1);
    expect(deleteManyCalls[0].where).toEqual({ date: dayStartTs });

    const createManyCalls = (mockPrisma.dailyStats.createMany as any).mock.calls;
    let createData: any;
    if (createManyCalls.length > 0) {
      const args = createManyCalls[0][0];
      createData = Array.isArray(args.data) ? args.data[0] : args.data;
    } else {
      const dailyStatsCreate = vi.mocked(mockPrisma.dailyStats.create);
      expect(dailyStatsCreate).toHaveBeenCalledTimes(1);
      createData = dailyStatsCreate.mock.calls[0][0].data;
    }
    // 只含残留日志（2 条），不是「旧 5 条 + 新 2 条 = 7 条」的双倍累加
    expect(createData.totalRequests).toBe(2);
    expect(createData.totalTokens).toBe(20);
  });
});
