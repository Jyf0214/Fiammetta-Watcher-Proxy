/**
 * format.ts 纯函数单元测试
 *
 * 覆盖 formatDuration / formatCompactNumber / formatCompact / valueFontSize
 */

import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatCompactNumber,
  formatCompact,
  valueFontSize,
} from "../format";

// ==================== formatDuration ====================

describe("formatDuration", () => {
  it("< 1000ms 返回毫秒单位", () => {
    expect(formatDuration(0)).toEqual({ value: "0", suffix: "ms" });
    expect(formatDuration(1)).toEqual({ value: "1", suffix: "ms" });
    expect(formatDuration(500)).toEqual({ value: "500", suffix: "ms" });
    expect(formatDuration(999)).toEqual({ value: "999", suffix: "ms" });
  });

  it(">= 1000ms 转换为秒，保留两位小数", () => {
    expect(formatDuration(1000)).toEqual({ value: "1.00", suffix: "s" });
    expect(formatDuration(1500)).toEqual({ value: "1.50", suffix: "s" });
    expect(formatDuration(60000)).toEqual({ value: "60.00", suffix: "s" });
  });

  it("传入 t 函数时使用 i18n 单位", () => {
    const t = (key: string) => (key === "common:unitSec" ? "秒" : "毫秒");
    expect(formatDuration(500, t)).toEqual({ value: "500", suffix: "毫秒" });
    expect(formatDuration(2000, t)).toEqual({ value: "2.00", suffix: "秒" });
  });

  it("四舍五入毫秒值", () => {
    expect(formatDuration(123.4)).toEqual({ value: "123", suffix: "ms" });
    expect(formatDuration(123.6)).toEqual({ value: "124", suffix: "ms" });
  });
});

// ==================== formatCompactNumber ====================

describe("formatCompactNumber", () => {
  it("< 1000 返回 toLocaleString", () => {
    expect(formatCompactNumber(0)).toBe("0");
    expect(formatCompactNumber(42)).toBe("42");
    expect(formatCompactNumber(999)).toBe("999");
  });

  it(">= 1000 返回 K 后缀", () => {
    expect(formatCompactNumber(1000)).toBe("1.00K");
    expect(formatCompactNumber(1500)).toBe("1.50K");
    expect(formatCompactNumber(999999)).toBe("1000.00K");
  });

  it(">= 1e6 返回 M 后缀", () => {
    expect(formatCompactNumber(1_000_000)).toBe("1.00M");
    expect(formatCompactNumber(2_500_000)).toBe("2.50M");
  });

  it(">= 1e9 返回 B 后缀", () => {
    expect(formatCompactNumber(1_000_000_000)).toBe("1.00B");
    expect(formatCompactNumber(3_500_000_000)).toBe("3.50B");
  });

  it("传入 t 函数时使用 i18n 后缀", () => {
    const t = (key: string) =>
      key === "common:unitB" ? "十亿" : key === "common:unitM" ? "百万" : "千";
    expect(formatCompactNumber(1000, t)).toBe("1.00千");
    expect(formatCompactNumber(1_000_000, t)).toBe("1.00百万");
    expect(formatCompactNumber(1_000_000_000, t)).toBe("1.00十亿");
  });
});

// ==================== formatCompact ====================

describe("formatCompact", () => {
  it("< 1000 返回原始值字符串", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(42)).toBe("42");
    expect(formatCompact(999)).toBe("999");
  });

  it(">= 1000 返回 1 位小数 K", () => {
    expect(formatCompact(1000)).toBe("1.0K");
    expect(formatCompact(1500)).toBe("1.5K");
    expect(formatCompact(9999)).toBe("10.0K");
  });

  it(">= 1e6 返回 1 位小数 M", () => {
    expect(formatCompact(1_000_000)).toBe("1.0M");
    expect(formatCompact(2_500_000)).toBe("2.5M");
  });

  it(">= 1e9 返回 1 位小数 B", () => {
    expect(formatCompact(1_000_000_000)).toBe("1.0B");
    expect(formatCompact(3_500_000_000)).toBe("3.5B");
  });

  it("支持负数", () => {
    expect(formatCompact(-1500)).toBe("-1.5K");
    expect(formatCompact(-1_000_000)).toBe("-1.0M");
    expect(formatCompact(-42)).toBe("-42");
  });

  it("传入 t 函数时使用 i18n 后缀", () => {
    const t = (key: string) =>
      key === "common:unitK" ? "K(中文)" : key === "common:unitM" ? "M(中文)" : "B(中文)";
    expect(formatCompact(1000, t)).toBe("1.0K(中文)");
    expect(formatCompact(-2_000_000, t)).toBe("-2.0M(中文)");
  });
});

// ==================== valueFontSize ====================

describe("valueFontSize", () => {
  it("长度 <= 5 返回 text-lg", () => {
    expect(valueFontSize("1")).toBe("text-lg");
    expect(valueFontSize("12345")).toBe("text-lg");
  });

  it("长度 6-8 返回 text-base", () => {
    expect(valueFontSize("123456")).toBe("text-base");
    expect(valueFontSize("12345678")).toBe("text-base");
  });

  it("长度 > 8 返回 text-sm", () => {
    expect(valueFontSize("123456789")).toBe("text-sm");
    expect(valueFontSize("12345678901234")).toBe("text-sm");
  });
});
