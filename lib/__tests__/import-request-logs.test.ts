/**
 * requestLogs 导入逻辑测试
 *
 * 直接验证生产代码 pages/api/admin/import.ts 的 importRequestLogs / toUnixSeconds / sanitize 工具：
 * 1. 外键校验 — keyId/platformId 不存在时置 null（避免 FOREIGN KEY 约束失败）
 * 2. duration → latency 映射
 * 3. ISO 日期 → unix 秒
 * 4. 无 model 记录被跳过
 * 5. 字段缺失时使用默认值
 * 6. 1000 条批量场景
 * 7. sanitize 工具边界（上界/枚举/布尔/状态码/时间戳）
 *
 * 数据库使用虚拟 PostgreSQL（PGlite 内存实例，仅存在于测试进程），
 * 表结构由 prisma migrate diff 从 prisma/schema.pg.prisma 派生，
 * 经 lib/prisma 真实 createDb 工厂（pg 方言）连接；数据读写全部经 Prisma ORM 模型 API。
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  importRequestLogs,
  toUnixSeconds,
  sanitizeNonNegativeInt,
  sanitizeNonNegativeFloat,
  sanitizeBoolean,
  sanitizeEnum,
  sanitizeString,
  sanitizeNullableString,
  sanitizeHttpStatus,
  sanitizeExpiresAt,
} from "../../pages/api/admin/import";
import { createTestDb } from "./helpers/test-pg-db";
import type { Database } from "@/lib/prisma";

let db: Database;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const created = await createTestDb();
  db = created.db;
  cleanup = created.cleanup;
}, 120_000);

beforeEach(async () => {
  await db.requestLogs.deleteMany({});
  await db.apiKeys.deleteMany({});
  await db.platforms.deleteMany({});
});

afterAll(async () => {
  await cleanup();
}, 120_000);

// ==================== requestLogs 导入：外键校验 ====================

describe("requestLogs 导入：外键校验", () => {
  it("keyId/platformId 存在时正常插入", async () => {
    await db.apiKeys.create({ data: { id: "key-001", key: "test-key", name: "Test Key" } });
    await db.platforms.create({
      data: { id: "plat-001", name: "Test Platform", baseUrl: "http://test.com", apiKeys: "[]", forwardHeaders: "[]" },
    });

    const result = await importRequestLogs(db, [
      {
        keyId: "key-001", platformId: "plat-001", model: "gpt-4",
        status: 200, tokens: 100, duration: 500, createdAt: "2026-07-19T00:00:00.000Z",
      },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);

    const rows = await db.requestLogs.findMany({
      select: { keyId: true, platformId: true, model: true, latency: true },
    });
    expect(rows[0]).toEqual({ keyId: "key-001", platformId: "plat-001", model: "gpt-4", latency: 500 });
  });

  it("keyId/platformId 不存在时置 null（不报外键错误）", async () => {
    const result = await importRequestLogs(db, [
      {
        keyId: "non-existent-key", platformId: "non-existent-platform", model: "gpt-4",
        status: 200, tokens: 100, duration: 500, createdAt: "2026-07-19T00:00:00.000Z",
      },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);

    const rows = await db.requestLogs.findMany({ select: { keyId: true, platformId: true } });
    expect(rows[0]).toEqual({ keyId: null, platformId: null });
  });

  it("混合场景：部分 keyId 存在，部分不存在", async () => {
    await db.apiKeys.create({ data: { id: "key-001", key: "test-key", name: "Test Key" } });
    await db.platforms.create({
      data: { id: "plat-001", name: "Test Platform", baseUrl: "http://test.com", apiKeys: "[]", forwardHeaders: "[]" },
    });

    const result = await importRequestLogs(db, [
      { keyId: "key-001", platformId: "plat-001", model: "gpt-4", status: 200, duration: 500, createdAt: "2026-07-19T00:00:00.000Z" },
      { keyId: "non-existent", platformId: "non-existent", model: "gpt-3.5", status: 200, duration: 200, createdAt: "2026-07-19T01:00:00.000Z" },
      { keyId: "key-001", platformId: "non-existent", model: "claude-3", status: 200, duration: 1000, createdAt: "2026-07-19T02:00:00.000Z" },
    ]);

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);

    const rows = await db.requestLogs.findMany({
      orderBy: { createdAt: "asc" },
      select: { keyId: true, platformId: true, model: true, latency: true },
    });
    expect(rows[0]).toEqual({ keyId: "key-001", platformId: "plat-001", model: "gpt-4", latency: 500 });
    expect(rows[1]).toEqual({ keyId: null, platformId: null, model: "gpt-3.5", latency: 200 });
    expect(rows[2]).toEqual({ keyId: "key-001", platformId: null, model: "claude-3", latency: 1000 });
  });
});

// ==================== requestLogs 导入：字段映射 ====================

describe("requestLogs 导入：字段映射", () => {
  it("duration 映射为 latency", async () => {
    const result = await importRequestLogs(db, [
      { model: "gpt-4", status: 200, duration: 16685, tokens: 788, promptTokens: 728, completionTokens: 60, createdAt: "2026-07-19T05:56:17.010Z" },
    ]);
    expect(result.imported).toBe(1);
    const rows = await db.requestLogs.findMany({
      select: { latency: true, tokens: true, promptTokens: true, completionTokens: true },
    });
    expect(rows[0]).toEqual({ latency: 16685, tokens: 788, promptTokens: 728, completionTokens: 60 });
  });

  it("ISO 日期字符串转为 unix 秒", async () => {
    const result = await importRequestLogs(db, [
      { model: "gpt-4", status: 200, duration: 100, createdAt: "2026-07-19T05:56:17.010Z" },
    ]);
    expect(result.imported).toBe(1);
    const rows = await db.requestLogs.findMany({ select: { createdAt: true } });
    const expectedTs = Math.floor(new Date("2026-07-19T05:56:17.010Z").getTime() / 1000);
    expect(rows[0].createdAt).toBe(expectedTs);
  });

  it("无 model 字段的记录被跳过", async () => {
    const result = await importRequestLogs(db, [
      { status: 200, duration: 100 },
      { model: "gpt-4", status: 200, duration: 100 },
    ]);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("字段缺失时使用默认值", async () => {
    const result = await importRequestLogs(db, [{ model: "gpt-4" }]);
    expect(result.imported).toBe(1);
    const rows = await db.requestLogs.findMany({
      select: { status: true, latency: true, tokens: true, promptTokens: true, completionTokens: true, ttft: true, cost: true, isError: true },
    });
    expect(rows[0]).toEqual({ status: 0, latency: 0, tokens: 0, promptTokens: 0, completionTokens: 0, ttft: 0, cost: 0, isError: false });
  });
});

// ==================== requestLogs 导入：批量场景 ====================

// 1000 条 × 虚拟 PostgreSQL 的批量写在全量并发下较慢，放宽超时
const BULK_TIMEOUT = 30_000;

describe("requestLogs 导入：批量场景", () => {
  it("1000 条记录 — 外键全部存在时成功", async () => {
    await db.apiKeys.create({ data: { id: "cmr98pf8c0003c901nu8icnev", key: "test-key", name: "Test Key" } });
    await db.platforms.create({
      data: { id: "cmrewguvw006qeo01bnj25l6w", name: "Platform A", baseUrl: "http://a.com", apiKeys: "[]", forwardHeaders: "[]" },
    });
    await db.platforms.create({
      data: { id: "cmra4pg1u0000er01k73pzpik", name: "Platform B", baseUrl: "http://b.com", apiKeys: "[]", forwardHeaders: "[]" },
    });

    const logs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 1000; i++) {
      logs.push({
        keyId: "cmr98pf8c0003c901nu8icnev",
        platformId: i % 2 === 0 ? "cmrewguvw006qeo01bnj25l6w" : "cmra4pg1u0000er01k73pzpik",
        model: "agnes-2.0-flash", status: 200, tokens: 788,
        promptTokens: 728, completionTokens: 60, ttft: 0,
        duration: 16685, isError: false, createdAt: "2026-07-19T05:56:17.010Z",
      });
    }

    const result = await importRequestLogs(db, logs);
    expect(result.imported).toBe(1000);
    expect(result.skipped).toBe(0);

    expect(await db.requestLogs.count()).toBe(1000);
  }, BULK_TIMEOUT);

  it("1000 条记录 — 外键全部不存在时也能成功（置 null）", async () => {
    const logs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 1000; i++) {
      logs.push({
        keyId: "non-existent-key", platformId: "non-existent-platform",
        model: "gpt-4", status: 200, tokens: 100, duration: 500,
        createdAt: "2026-07-19T00:00:00.000Z",
      });
    }

    const result = await importRequestLogs(db, logs);
    expect(result.imported).toBe(1000);
    expect(result.skipped).toBe(0);

    const nullCount = await db.requestLogs.count({
      where: { keyId: null, platformId: null },
    });
    expect(nullCount).toBe(1000);
  }, BULK_TIMEOUT);
});

// ==================== toUnixSeconds：时间戳范围校验（真实生产代码） ====================

describe("toUnixSeconds：时间戳范围校验", () => {
  it("合理范围内的秒级时间戳原样保留", () => {
    expect(toUnixSeconds(1785600000)).toBe(1785600000); // 2026-08-01
    expect(toUnixSeconds(1704067200)).toBe(1704067200); // 2024-01-01 边界
  });

  it("2009 年秒级时间戳（如 1234483200）回退为当前时间", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = toUnixSeconds(1234483200);
    expect(result).toBeGreaterThanOrEqual(now - 5);
    expect(result).toBeLessThanOrEqual(now + 5);
  });

  it("未来时间戳（如 2100 年）回退为当前时间", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = toUnixSeconds(4102444800);
    expect(result).toBeGreaterThanOrEqual(now - 5);
    expect(result).toBeLessThanOrEqual(now + 5);
  });

  it("2009 年 ISO 日期字符串回退为当前时间", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = toUnixSeconds("2009-02-13T00:00:00.000Z");
    expect(result).toBeGreaterThanOrEqual(now - 5);
    expect(result).toBeLessThanOrEqual(now + 5);
  });

  it("非法输入回退为当前时间", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = toUnixSeconds("not-a-date");
    expect(result).toBeGreaterThanOrEqual(now - 5);
    expect(result).toBeLessThanOrEqual(now + 5);
  });
});

// ==================== sanitize 工具函数（真实 import.ts 代码） ====================

describe("sanitizeNonNegativeInt / sanitizeNonNegativeFloat：数值钳制", () => {
  it("正常非负整数保留", () => {
    expect(sanitizeNonNegativeInt(100)).toBe(100);
    expect(sanitizeNonNegativeInt(0)).toBe(0);
    expect(sanitizeNonNegativeInt(100.9)).toBe(100);
    expect(sanitizeNonNegativeInt("42")).toBe(42);
  });

  it("负数/NaN/Infinity/非数字返回 null", () => {
    expect(sanitizeNonNegativeInt(-1)).toBeNull();
    expect(sanitizeNonNegativeInt("abc")).toBeNull();
    expect(sanitizeNonNegativeInt(NaN)).toBeNull();
    expect(sanitizeNonNegativeInt(Infinity)).toBeNull();
    expect(sanitizeNonNegativeInt(null)).toBeNull();
    expect(sanitizeNonNegativeInt(undefined)).toBeNull();
    expect(sanitizeNonNegativeFloat(-0.5)).toBeNull();
    expect(sanitizeNonNegativeFloat("x")).toBeNull();
  });

  it("超出 Int32/Float 安全范围返回 null（防整批 createMany 失败）", () => {
    expect(sanitizeNonNegativeInt(2147483647)).toBe(2147483647);
    expect(sanitizeNonNegativeInt(2147483648)).toBeNull();
    expect(sanitizeNonNegativeInt(5_000_000_000)).toBeNull();
    expect(sanitizeNonNegativeInt("1e308")).toBeNull();
    expect(sanitizeNonNegativeFloat(1e15)).toBe(1e15);
    expect(sanitizeNonNegativeFloat(1e20)).toBeNull();
  });

  it("浮点数值保留（Float 字段）", () => {
    expect(sanitizeNonNegativeFloat(1.25)).toBe(1.25);
    expect(sanitizeNonNegativeFloat("3.5")).toBe(3.5);
    expect(sanitizeNonNegativeFloat(0)).toBe(0);
  });
});

describe("sanitizeBoolean：仅接受 true/false", () => {
  it("布尔值原样返回", () => {
    expect(sanitizeBoolean(true, false)).toBe(true);
    expect(sanitizeBoolean(false, true)).toBe(false);
  });

  it("字符串 'false' 等非布尔值回退默认值", () => {
    expect(sanitizeBoolean("false", true)).toBe(true);
    expect(sanitizeBoolean("true", false)).toBe(false);
    expect(sanitizeBoolean(1, false)).toBe(false);
    expect(sanitizeBoolean(undefined, true)).toBe(true);
  });
});

describe("sanitizeEnum：白名单回退", () => {
  const valid = new Set(["daily", "monthly", "never"]);

  it("命中白名单返回原值", () => {
    expect(sanitizeEnum("daily", valid, "monthly")).toBe("daily");
    expect(sanitizeEnum("never", valid, "monthly")).toBe("never");
  });

  it("未命中回退默认值", () => {
    expect(sanitizeEnum("weekly", valid, "monthly")).toBe("monthly");
    expect(sanitizeEnum(123, valid, "monthly")).toBe("monthly");
    expect(sanitizeEnum(undefined, valid, "monthly")).toBe("monthly");
  });
});

describe("sanitizeString / sanitizeNullableString：类型与截断", () => {
  it("非字符串返回空串/null", () => {
    expect(sanitizeString(123)).toBe("");
    expect(sanitizeString(null)).toBe("");
    expect(sanitizeString(undefined)).toBe("");
    expect(sanitizeNullableString(123)).toBeNull();
    expect(sanitizeNullableString("")).toBeNull();
  });

  it("超长截断到 maxLen", () => {
    expect(sanitizeString("a".repeat(300), 191).length).toBe(191);
    expect(sanitizeNullableString("a".repeat(300), 10)).toBe("a".repeat(10));
    expect(sanitizeNullableString("正常字符串", 10)).toBe("正常字符串");
  });
});

describe("sanitizeHttpStatus：状态码范围", () => {
  it("0~599 保留", () => {
    expect(sanitizeHttpStatus(200)).toBe(200);
    expect(sanitizeHttpStatus(599)).toBe(599);
    expect(sanitizeHttpStatus(0)).toBe(0);
  });

  it("负数/超范围/非数字回退 0", () => {
    expect(sanitizeHttpStatus(600)).toBe(0);
    expect(sanitizeHttpStatus(-1)).toBe(0);
    expect(sanitizeHttpStatus("abc")).toBe(0);
    expect(sanitizeHttpStatus(undefined)).toBe(0);
  });
});

describe("sanitizeExpiresAt：过期时间范围", () => {
  it("合理秒级时间戳保留", () => {
    const ts = Math.floor(Date.now() / 1000) + 86400;
    expect(sanitizeExpiresAt(ts)).toBe(ts);
  });

  it("ISO 日期字符串转换", () => {
    const ts = Math.floor(Date.now() / 1000) + 86400;
    const iso = new Date(ts * 1000).toISOString();
    expect(sanitizeExpiresAt(iso)).toBe(ts);
  });

  it("2009 年/未来 10 年后/非法输入返回 null", () => {
    expect(sanitizeExpiresAt(1234483200)).toBeNull();
    expect(sanitizeExpiresAt(4102444800)).toBeNull();
    expect(sanitizeExpiresAt("not-a-date")).toBeNull();
    expect(sanitizeExpiresAt(undefined)).toBeNull();
  });
});

// ==================== requestLogs 导入：违规数据净化（真实生产函数 + ORM 断言） ====================

describe("requestLogs 导入：违规数据净化", () => {
  it("负数/非数字数值钳制为 0，字符串 'false' 的 isError 不生效", async () => {
    const result = await importRequestLogs(db, [
      {
        model: "gpt-4", status: -1, tokens: -100, latency: -5, cost: -0.5,
        duration: "abc", isError: "false",
      },
    ]);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);

    const rows = await db.requestLogs.findMany({
      select: { status: true, latency: true, tokens: true, cost: true, isError: true },
    });
    expect(rows[0]).toEqual({ status: 0, latency: 0, tokens: 0, cost: 0, isError: false });
  });

  it("状态码超过 599 钳制为 0", async () => {
    await importRequestLogs(db, [{ model: "gpt-4", status: 600 }]);
    const rows = await db.requestLogs.findMany({ select: { status: true } });
    expect(rows[0].status).toBe(0);
  });

  it("非字符串 model 记录被跳过", async () => {
    const result = await importRequestLogs(db, [
      { model: 123, status: 200 },
      { model: null, status: 200 },
      { model: "gpt-4", status: 200 },
    ]);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it("超长 method 截断到 10", async () => {
    await importRequestLogs(db, [
      { model: "gpt-4", method: "POST".repeat(20), status: 200 },
    ]);
    const rows = await db.requestLogs.findMany({ select: { method: true } });
    expect((rows[0].method as string).length).toBe(10);
  });
});