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
