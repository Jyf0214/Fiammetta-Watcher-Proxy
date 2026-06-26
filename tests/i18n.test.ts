import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "fs";

const messagesDir = resolve(__dirname, "../messages");
const srcDir = resolve(__dirname, "../src");

function loadJson(file: string) {
  return JSON.parse(readFileSync(resolve(messagesDir, file), "utf-8"));
}

function flatten(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "object" && val !== null) {
      Object.assign(result, flatten(val as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = String(val);
    }
  }
  return result;
}

function findTsxFiles(dir: string): string[] {
  const { readdirSync, statSync } = require("fs");
  const { join } = require("path");
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTsxFiles(full));
    } else if (/\.tsx$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

const zh = loadJson("zh.json");
const en = loadJson("en.json");
const zhFlat = flatten(zh);
const enFlat = flatten(en);
const zhKeys = new Set(Object.keys(zhFlat));
const enKeys = new Set(Object.keys(enFlat));

describe("i18n 翻译键完整性", () => {
  it("zh.json 和 en.json 的键应完全一致", () => {
    const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
    const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));

    const errors: string[] = [];
    if (missingInEn.length > 0) {
      errors.push(`en.json 缺少 ${missingInEn.length} 个键: ${missingInEn.join(", ")}`);
    }
    if (missingInZh.length > 0) {
      errors.push(`zh.json 缺少 ${missingInZh.length} 个键: ${missingInZh.join(", ")}`);
    }

    expect(errors, errors.join("\n")).toHaveLength(0);
  });

  it("zh.json 不应有空值", () => {
    const emptyKeys = Object.entries(zhFlat)
      .filter(([_, val]) => !val || val.trim() === "")
      .map(([key]) => key);

    expect(emptyKeys, `空值键: ${emptyKeys.join(", ")}`).toHaveLength(0);
  });

  it("en.json 不应有空值", () => {
    const emptyKeys = Object.entries(enFlat)
      .filter(([_, val]) => !val || val.trim() === "")
      .map(([key]) => key);

    expect(emptyKeys, `空值键: ${emptyKeys.join(", ")}`).toHaveLength(0);
  });

  it("翻译键数量应大于 200", () => {
    expect(zhKeys.size).toBeGreaterThan(200);
    expect(enKeys.size).toBeGreaterThan(200);
  });
});

describe("源代码 i18n 引用校验", () => {
  const tKeyRegex = /\bt\(["']([a-zA-Z][a-zA-Z0-9_.]+)["']\)/g;

  // 只扫描前端 UI 文件（排除 API 路由、hooks、lib 等）
  const scanDirs = ["app/admin", "components"];
  const allTsxFiles: string[] = [];
  const { join } = require("path");

  for (const dir of scanDirs) {
    const fullPath = join(srcDir, dir);
    try {
      allTsxFiles.push(...findTsxFiles(fullPath));
    } catch {
      // 目录不存在则跳过
    }
  }

  // 也扫描首页
  const homePage = join(srcDir, "app/page.tsx");
  try {
    allTsxFiles.push(homePage);
  } catch {
    // 不存在则跳过
  }

  // 过滤：只保留导入了 i18n 的文件
  const { readFileSync: readSync } = require("fs");
  const filesWithI18n = allTsxFiles.filter((f: string) => {
    const content = readSync(f, "utf-8");
    return (
      content.includes('from "react-i18next"') ||
      content.includes("from 'react-i18next'")
    );
  });

  it("所有 t() 引用的键都应在翻译文件中存在", () => {
    const missing: string[] = [];

    for (const file of filesWithI18n) {
      const content = readSync(file, "utf-8");
      const relPath = file.replace(srcDir, "src");
      let match;
      while ((match = tKeyRegex.exec(content)) !== null) {
        const key = match[1];
        if (!zhFlat[key] && !enFlat[key]) {
          missing.push(`${key} (${relPath})`);
        }
      }
      tKeyRegex.lastIndex = 0;
    }

    expect(missing, `不存在的 i18n 键:\n${missing.join("\n")}`).toHaveLength(0);
  });

  it("不应使用 t() + 拼接方式构建验证消息", () => {
    // 检测 t("xxx") + "xxx" 模式（应使用完整键或参数化键）
    const badPatterns: string[] = [];

    for (const file of filesWithI18n) {
      const content = readSync(file, "utf-8");
      const relPath = file.replace(srcDir, "src");
      const lines = content.split("\n");
      lines.forEach((line: string, i: number) => {
        if (/t\(["'][^"']+["']\)\s*\+\s*["']/.test(line)) {
          badPatterns.push(`${relPath}:${i + 1}`);
        }
      });
    }

    expect(
      badPatterns,
      `检测到 t() 拼接模式（应使用完整 i18n 键）:\n${badPatterns.join("\n")}`
    ).toHaveLength(0);
  });
});
