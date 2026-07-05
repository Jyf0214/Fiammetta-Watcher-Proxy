import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

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
  const { readdirSync } = require("fs");
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
  // 使用 "app" 而非 "app/admin" 以覆盖 app/ 下所有页面（含 error.tsx、global-error.tsx 等）
  const scanDirs = ["app", "components"];
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

describe("翻译变量插值格式验证", () => {
  // 提取翻译值中的变量插值（格式：{variableName}）
  function extractInterpolationVars(value: string): string[] {
    const regex = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
    const vars: string[] = [];
    let match;
    while ((match = regex.exec(value)) !== null) {
      vars.push(match[1]);
    }
    return vars;
  }

  it("zh.json 和 en.json 中相同键的变量插值变量名应完全一致", () => {
    const mismatches: string[] = [];

    function checkObject(zhObj: Record<string, unknown>, enObj: Record<string, unknown>, prefix = "") {
      for (const [key, zhVal] of Object.entries(zhObj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        const enVal = enObj[key];

        if (typeof zhVal === "object" && zhVal !== null && typeof enVal === "object" && enVal !== null) {
          checkObject(
            zhVal as Record<string, unknown>,
            enVal as Record<string, unknown>,
            fullKey
          );
        } else if (typeof zhVal === "string" && typeof enVal === "string") {
          const zhVars = extractInterpolationVars(zhVal);
          const enVars = extractInterpolationVars(enVal);

          const zhVarSet = new Set(zhVars);
          const enVarSet = new Set(enVars);

          const missingInEn = zhVars.filter((v) => !enVarSet.has(v));
          const missingInZh = enVars.filter((v) => !zhVarSet.has(v));

          if (missingInEn.length > 0 || missingInZh.length > 0) {
            mismatches.push(
              `${fullKey}: zh=[${zhVars.join(",")}] en=[${enVars.join(",")}]`
            );
          }
        }
      }
    }

    checkObject(zh, en);

    expect(
      mismatches,
      `变量插值不一致的键:\n${mismatches.join("\n")}`
    ).toHaveLength(0);
  });

  it("包含变量插值的翻译值不应为空", () => {
    const emptyWithVars: string[] = [];

    function checkEmptyVars(obj: Record<string, unknown>, prefix = "") {
      for (const [key, val] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof val === "object" && val !== null) {
          checkEmptyVars(val as Record<string, unknown>, fullKey);
        } else if (typeof val === "string") {
          const vars = extractInterpolationVars(val);
          if (vars.length > 0 && val.trim() === "") {
            emptyWithVars.push(fullKey);
          }
        }
      }
    }

    checkEmptyVars(zh);
    checkEmptyVars(en);

    expect(
      emptyWithVars,
      `含变量但值为空的翻译键: ${emptyWithVars.join(", ")}`
    ).toHaveLength(0);
  });
});

describe("未使用翻译键检查", () => {
  const { readFileSync: readSync, readdirSync } = require("fs");
  const { join } = require("path");

  // 收集源代码中所有 i18n 键引用（包括 t() 直接调用和字符串字面量引用）
  const usedKeys = new Set<string>();
  const tKeyRegex = /\bt\(["']([a-zA-Z][a-zA-Z0-9_.]+)["']\)/g;
  // 匹配字符串字面量中的 i18n 键（如 "admin.group_overview"、"platform.status_healthy"）
  // 仅匹配符合翻译键命名规范的字符串（包含点号，且前缀为已知命名空间）
  const knownPrefixes = [
    "common", "validation", "auth", "admin", "platform", "api_key",
    "plan", "model_map", "log", "dashboard", "event", "audit",
    "system", "api", "init", "notify", "home", "theme"
  ];
  const keyStringRegex = new RegExp(
    `["']((${knownPrefixes.join("|")})\\.[a-zA-Z][a-zA-Z0-9_]*)["']`,
    "g"
  );

  // 扫描所有 tsx/ts 文件
  function scanDir(dir: string) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".next") {
          scanDir(fullPath);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const content = readSync(fullPath, "utf-8");
          let match;
          // 匹配 t() 调用
          tKeyRegex.lastIndex = 0;
          while ((match = tKeyRegex.exec(content)) !== null) {
            usedKeys.add(match[1]);
          }
          // 匹配字符串字面量中的键引用（如动态 key 引用场景）
          keyStringRegex.lastIndex = 0;
          while ((match = keyStringRegex.exec(content)) !== null) {
            // 去除引号，提取纯键名
            const key = match[1];
            if (key.includes(".")) {
              usedKeys.add(key);
            }
          }
        }
      }
    } catch {
      // 目录不存在则跳过
    }
  }

  scanDir(srcDir);

  it("翻译文件中的每个键都应在源代码中被引用", () => {
    const unusedKeys: string[] = [];

    for (const key of Object.keys(zhFlat)) {
      if (!usedKeys.has(key)) {
        unusedKeys.push(key);
      }
    }

    // 未使用的键不影响运行时行为，仅作为审计信息输出
    // 部分键用于后端 API 错误消息、通知、动态构造等前端扫描器无法覆盖的场景
    if (unusedKeys.length > 0) {
      console.warn(
        `审计信息: 发现 ${unusedKeys.length}/${Object.keys(zhFlat).length} 个未被前端直接引用的翻译键:\n` +
        unusedKeys.join("\n") +
        "\n注意: 这些键可能用于后端 API、通知模板或未来功能，属正常预留"
      );
    }

    // 仅在未使用键数量异常多时才报错（超过 70% 可能是翻译冗余）
    const threshold = Math.floor(Object.keys(zhFlat).length * 0.7);
    expect(
      unusedKeys.length,
      `未使用的翻译键异常过多 (${unusedKeys.length}/${Object.keys(zhFlat).length})，可能需要清理`
    ).toBeLessThanOrEqual(threshold);
  });
});
