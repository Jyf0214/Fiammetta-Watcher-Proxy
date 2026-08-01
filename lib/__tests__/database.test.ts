/**
 * Prisma 数据库工厂测试
 *
 * 验证 prisma.ts 的 createDb() / disconnectDb() 函数：
 * - 自动从 Cloudflare Context 获取 D1 binding
 * - 单例模式（同一进程复用实例）
 * - disconnectDb() 清理
 * - 缺失 DB binding 时的行为
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// ==================== 测试 ====================

describe("Prisma 工厂 (createDb)", () => {
  // 每个测试前清理全局缓存
  beforeEach(() => {
    const g = globalThis as unknown as { __prisma?: any };
    g.__prisma = undefined;
  });

  afterEach(async () => {
    const { disconnectDb } = await import("../prisma");
    await disconnectDb();
  });

  it("缺失 D1 binding 时抛出错误", async () => {
    const { createDb } = await import("../prisma");

    // 非 Cloudflare 环境，没有 D1 binding
    await expect(createDb()).rejects.toThrow("D1 数据库未配置");
  });

  it("disconnectDb 是幂等的（多次调用不报错）", async () => {
    const { disconnectDb } = await import("../prisma");
    await disconnectDb();
    await disconnectDb(); // 第二次调用不应报错
  });
});

describe("向后兼容导出", () => {
  it("src/lib/prisma.ts 重新导出 createDb", async () => {
    const srcPrisma = await import("../../src/lib/prisma");
    expect(typeof srcPrisma.createDb).toBe("function");
  });
});

describe("getDbKind 推断", () => {
  const ORIGINAL_DB_TYPE = process.env.DB_TYPE;
  const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

  afterEach(() => {
    if (ORIGINAL_DB_TYPE === undefined) delete process.env.DB_TYPE;
    else process.env.DB_TYPE = ORIGINAL_DB_TYPE;
    if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  });

  it("DB_TYPE=tidb 时返回 tidb", async () => {
    const { getDbKind } = await import("../prisma");
    process.env.DB_TYPE = "tidb";
    delete process.env.DATABASE_URL;
    expect(await getDbKind()).toBe("tidb");
  });

  it("DB_TYPE=pg 时返回 pg", async () => {
    const { getDbKind } = await import("../prisma");
    process.env.DB_TYPE = "pg";
    delete process.env.DATABASE_URL;
    expect(await getDbKind()).toBe("pg");
  });

  it("DB_TYPE=mysql 别名时返回 tidb", async () => {
    const { getDbKind } = await import("../prisma");
    process.env.DB_TYPE = "mysql";
    delete process.env.DATABASE_URL;
    expect(await getDbKind()).toBe("tidb");
  });

  it("无 DB_TYPE 时按 DATABASE_URL 协议推断", async () => {
    const { getDbKind } = await import("../prisma");
    delete process.env.DB_TYPE;

    process.env.DATABASE_URL = "mysql://user:pass@host/db";
    expect(await getDbKind()).toBe("tidb");

    process.env.DATABASE_URL = "mysqls://user:pass@host/db";
    expect(await getDbKind()).toBe("tidb");

    process.env.DATABASE_URL = "postgresql://user:pass@host/db";
    expect(await getDbKind()).toBe("pg");

    process.env.DATABASE_URL = "file:./placeholder.db";
    expect(await getDbKind()).toBe("d1");
  });

  it("无 DB_TYPE 且无 DATABASE_URL 时默认 d1", async () => {
    const { getDbKind } = await import("../prisma");
    delete process.env.DB_TYPE;
    delete process.env.DATABASE_URL;
    expect(await getDbKind()).toBe("d1");
  });
});
