/**
 * timezone.ts 纯函数单元测试
 *
 * 覆盖 formatDateTime / formatDate / formatTime
 * 使用固定时间戳验证 ISO 字符串和 Unix 秒时间戳两条输入路径
 */

import { describe, it, expect } from "vitest";
import { formatDateTime, formatDate, formatTime } from "../timezone";

// 使用固定时间戳避免时区差异：2025-01-15T10:30:45 UTC
const FIXED_ISO = "2025-01-15T10:30:45.000Z";
const FIXED_TS_SECONDS = 1736935845; // = new Date("2025-01-15T10:30:45.000Z").getTime() / 1000

// 期望结果基于运行环境的本地时区，所以只验证函数是否返回正确的类型且与 Date 一致
describe("formatDateTime", () => {
  it("ISO 字符串输入返回本地时间字符串", () => {
    const result = formatDateTime(FIXED_ISO);
    const expected = new Date(FIXED_ISO).toLocaleString();
    expect(result).toBe(expected);
  });

  it("Unix 秒时间戳输入返回本地时间字符串", () => {
    const result = formatDateTime(FIXED_TS_SECONDS);
    const expected = new Date(FIXED_TS_SECONDS * 1000).toLocaleString();
    expect(result).toBe(expected);
  });

  it("返回非空字符串", () => {
    const result = formatDateTime(FIXED_ISO);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("formatDate", () => {
  it("ISO 字符串输入返回本地日期", () => {
    const result = formatDate(FIXED_ISO);
    const expected = new Date(FIXED_ISO).toLocaleDateString();
    expect(result).toBe(expected);
  });

  it("Unix 秒时间戳输入返回本地日期", () => {
    const result = formatDate(FIXED_TS_SECONDS);
    const expected = new Date(FIXED_TS_SECONDS * 1000).toLocaleDateString();
    expect(result).toBe(expected);
  });
});

describe("formatTime", () => {
  it("ISO 字符串输入返回本地时间", () => {
    const result = formatTime(FIXED_ISO);
    const expected = new Date(FIXED_ISO).toLocaleTimeString();
    expect(result).toBe(expected);
  });

  it("Unix 秒时间戳输入返回本地时间", () => {
    const result = formatTime(FIXED_TS_SECONDS);
    const expected = new Date(FIXED_TS_SECONDS * 1000).toLocaleTimeString();
    expect(result).toBe(expected);
  });
});
