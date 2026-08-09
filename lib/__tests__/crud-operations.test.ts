/**
 * Prisma Client 操作测试
 *
 * 验证 Prisma 生成的客户端可以正常执行增删改查操作。
 * 数据库使用虚拟 PostgreSQL（PGlite 内存实例，仅存在于测试进程），
 * 表结构由 prisma migrate diff 从 prisma/schema.pg.prisma 派生，
 * 经 lib/prisma 真实 createDb 工厂（pg 方言）连接——与生产完全同源。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb } from "./helpers/test-pg-db";

let prisma: Awaited<ReturnType<typeof createTestDb>>["db"];
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const created = await createTestDb();
  prisma = created.db;
  cleanup = created.cleanup;
}, 120_000);

afterAll(async () => {
  await cleanup();
}, 120_000);

// ==================== 测试 ====================

describe("CRUD: admins 表", () => {
  it("可以创建管理员", async () => {
    const now = Math.floor(Date.now() / 1000);
    const admin = await prisma.admins.create({
      data: { id: "test-1", username: "testuser", passwordHash: "hash123", createdAt: now, updatedAt: now },
    });
    expect(admin.id).toBe("test-1");
    expect(admin.username).toBe("testuser");
  });

  it("可以查询管理员", async () => {
    const admin = await prisma.admins.findFirst({ where: { username: "testuser" } });
    expect(admin).not.toBeNull();
    expect(admin!.id).toBe("test-1");
  });

  it("可以更新管理员", async () => {
    const updated = await prisma.admins.update({
      where: { id: "test-1" },
      data: { username: "newname" },
    });
    expect(updated.username).toBe("newname");
  });

  it("可以删除管理员", async () => {
    await prisma.admins.delete({ where: { id: "test-1" } });
    const admin = await prisma.admins.findFirst({ where: { id: "test-1" } });
    expect(admin).toBeNull();
  });
});

describe("CRUD: api_keys 表", () => {
  it("可以创建 API Key", async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = await prisma.apiKeys.create({
      data: {
        id: "key-1", key: "sk-test-1", name: "Key 1",
        usedTokens: 0, callUsed: 0, status: "active",
        createdAt: now, updatedAt: now,
      },
    });
    expect(key.key).toBe("sk-test-1");
  });

  it("可以批量查询", async () => {
    const keys = await prisma.apiKeys.findMany();
    expect(keys.length).toBeGreaterThanOrEqual(1);
  });

  it("可以条件查询", async () => {
    const key = await prisma.apiKeys.findFirst({ where: { key: "sk-test-1" } });
    expect(key).not.toBeNull();
    expect(key!.name).toBe("Key 1");
  });

  it("可以更新字段", async () => {
    const updated = await prisma.apiKeys.update({
      where: { id: "key-1" },
      data: { usedTokens: { increment: 100 } },
    });
    expect(updated.usedTokens).toBe(100);
  });

  it("可以删除", async () => {
    await prisma.apiKeys.delete({ where: { id: "key-1" } });
    const key = await prisma.apiKeys.findFirst({ where: { id: "key-1" } });
    expect(key).toBeNull();
  });
});

describe("CRUD: request_logs 表", () => {
  it("可以创建请求日志（宽表 21 列）", async () => {
    const now = Math.floor(Date.now() / 1000);
    const log = await prisma.requestLogs.create({
      data: {
        id: "log-1", keyId: "key-1", keyName: "Test Key", platformId: "platform-1",
        model: "gpt-4", endpoint: "/v1/chat/completions", method: "POST",
        status: 200, latency: 1500, tokens: 100, promptTokens: 50, completionTokens: 50,
        ttft: 200, cost: 0.001, isError: false, createdAt: now,
      },
    });
    expect(log.model).toBe("gpt-4");
    expect(log.tokens).toBe(100);
  });

  it("可以条件查询 + 排序", async () => {
    const logs = await prisma.requestLogs.findMany({
      where: { keyId: "key-1" },
      orderBy: { createdAt: "desc" },
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("可以 count 查询", async () => {
    const count = await prisma.requestLogs.count({ where: { keyId: "key-1" } });
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("可以清理测试数据", async () => {
    await prisma.requestLogs.deleteMany({});
    const count = await prisma.requestLogs.count();
    expect(count).toBe(0);
  });
});

describe("CRUD: platforms 表", () => {
  it("可以创建平台（含 JSON 字段）", async () => {
    const now = Math.floor(Date.now() / 1000);
    const platform = await prisma.platforms.create({
      data: {
        id: "platform-1", name: "OpenAI", baseUrl: "https://api.openai.com",
        apiKeys: JSON.stringify([{ name: "default", key: "sk-xxx" }]),
        type: "openai", enabled: true, priority: 0, weight: 1,
        status: "healthy", failCount: 0, forwardHeaders: "[]",
        createdAt: now, updatedAt: now,
      },
    });
    expect(platform.name).toBe("OpenAI");
  });

  it("可以原子递增 failCount", async () => {
    const updated = await prisma.platforms.update({
      where: { id: "platform-1" },
      data: { failCount: { increment: 1 } },
    });
    expect(updated.failCount).toBe(1);
  });

  it("可以清理测试数据", async () => {
    await prisma.platforms.deleteMany({});
  });
});
