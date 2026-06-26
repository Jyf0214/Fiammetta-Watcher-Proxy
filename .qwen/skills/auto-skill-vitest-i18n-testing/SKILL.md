---
name: vitest-i18n-testing
description: 使用 vitest 进行 i18n 翻译完整性测试，自动在 pre-commit/pre-push 中运行
source: auto-skill
extracted_at: '2026-06-26T11:35:00.000Z'
---

# vitest i18n 完整性测试模式

## 核心思路

用 vitest 编写 i18n 测试用例，在 pre-commit 和 pre-push 中通过 `npm test` 自动运行，确保每次提交/推送时翻译键完整、无空值、源代码引用有效。

## 1. 安装与配置

```bash
npm install -D vitest
```

package.json 添加 test 脚本：

```json
{
  "scripts": {
    "test": "vitest run"
  }
}
```

## 2. 测试用例

测试文件放在 `tests/` 目录下，例如 `tests/i18n.test.ts`：

```ts
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
  const { readdirSync, statSync } = require("fs");
  const { join } = require("path");
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findTsxFiles(full));
    else if (/\.tsx$/.test(entry.name)) results.push(full);
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
    if (missingInEn.length > 0) errors.push(`en.json 缺少: ${missingInEn.join(", ")}`);
    if (missingInZh.length > 0) errors.push(`zh.json 缺少: ${missingInZh.join(", ")}`);
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

  it("翻译键数量应大于阈值", () => {
    expect(zhKeys.size).toBeGreaterThan(200);
    expect(enKeys.size).toBeGreaterThan(200);
  });
});

describe("源代码 i18n 引用校验", () => {
  const tKeyRegex = /\bt\(["']([a-zA-Z][a-zA-Z0-9_.]+)["']\)/g;
  const scanDirs = ["app/admin", "components"];
  const { join } = require("path");
  const allTsxFiles: string[] = [];

  for (const dir of scanDirs) {
    const fullPath = join(srcDir, dir);
    try { allTsxFiles.push(...findTsxFiles(fullPath)); } catch {}
  }
  try { allTsxFiles.push(join(srcDir, "app/page.tsx")); } catch {}

  const { readFileSync: readSync } = require("fs");
  const filesWithI18n = allTsxFiles.filter((f: string) => {
    const content = readSync(f, "utf-8");
    return content.includes('from "react-i18next"') || content.includes("from 'react-i18next'");
  });

  it("所有 t() 引用的键都应在翻译文件中存在", () => {
    const missing: string[] = [];
    for (const file of filesWithI18n) {
      const content = readSync(file, "utf-8");
      const relPath = file.replace(srcDir, "src");
      let match;
      while ((match = tKeyRegex.exec(content)) !== null) {
        const key = match[1];
        if (!zhFlat[key] && !enFlat[key]) missing.push(`${key} (${relPath})`);
      }
      tKeyRegex.lastIndex = 0;
    }
    expect(missing, `不存在的 i18n 键:\n${missing.join("\n")}`).toHaveLength(0);
  });

  it("不应使用 t() + 拼接方式构建验证消息", () => {
    const badPatterns: string[] = [];
    for (const file of filesWithI18n) {
      const content = readSync(file, "utf-8");
      const relPath = file.replace(srcDir, "src");
      content.split("\n").forEach((line: string, i: number) => {
        if (/t\(["'][^"']+["']\)\s*\+\s*["']/.test(line)) {
          badPatterns.push(`${relPath}:${i + 1}`);
        }
      });
    }
    expect(badPatterns, `检测到 t() 拼接模式:\n${badPatterns.join("\n")}`).toHaveLength(0);
  });
});
```

## 3. 注入 Git Hooks

### pre-commit

```bash
#!/bin/sh
echo "🔍 [pre-commit] 开始代码质量检查..."

echo "🧪 [pre-commit] 运行测试..."
npm test 2>&1
if [ $? -ne 0 ]; then
  echo "❌ [pre-commit] 测试失败，提交被阻止"
  exit 1
fi
echo "✅ [pre-commit] 测试通过"

# TypeScript 类型检查
echo "📝 [pre-commit] 运行 TypeScript 类型检查..."
npx tsc --noEmit
if [ $? -ne 0 ]; then
  echo "❌ [pre-commit] TypeScript 类型检查失败，提交被阻止"
  exit 1
fi
echo "✅ [pre-commit] TypeScript 类型检查通过"

# ESLint
echo "🔍 [pre-commit] 运行 ESLint 检查..."
npx eslint src/ 2>&1
if [ $? -ne 0 ]; then
  echo "❌ [pre-commit] ESLint 检查失败，提交被阻止"
  exit 1
fi
echo "✅ [pre-commit] ESLint 检查通过"

echo "🎉 [pre-commit] 所有检查通过，允许提交"
```

### pre-push

```bash
#!/bin/sh
echo "🚀 [pre-push] 开始构建验证..."

echo "🧪 [pre-push] 运行测试..."
npm test 2>&1
if [ $? -ne 0 ]; then
  echo "❌ [pre-push] 测试失败，推送被阻止"
  exit 1
fi
echo "✅ [pre-push] 测试通过"

# Prisma generate
echo "📦 [pre-push] 运行 Prisma generate..."
npx prisma generate 2>/dev/null
if [ $? -ne 0 ]; then
  echo "❌ [pre-push] Prisma generate 失败，推送被阻止"
  exit 1
fi
echo "✅ [pre-push] Prisma generate 通过"

# Next.js 构建
echo "🔨 [pre-push] 运行 Next.js 构建..."
npm run build 2>&1 | tail -5
if [ $? -ne 0 ]; then
  echo "❌ [pre-push] Next.js 构建失败，推送被阻止"
  exit 1
fi
echo "✅ [pre-push] Next.js 构建通过"

echo "🎉 [pre-push] 所有验证通过，允许推送"
```

## 4. 关键设计决策

### 为什么用 vitest 而不是自定义 Node.js 脚本

- vitest 有完整的断言库、describe/it 结构、彩色输出
- `npm test` 一条命令运行所有测试文件
- 未来新增测试只需在 `tests/` 目录下添加文件，自动被收集
- pre-commit/pre-push 只需调用 `npm test`，不需要指定具体文件

### 为什么只扫描 .tsx 文件且过滤有 useTranslation 的文件

- `.ts` 文件（API 路由、hooks、lib）中的 `t()` 不是 i18n 调用（可能是变量名、函数名）
- 只检查导入了 `react-i18next` 的文件，避免误报
- 正则 `\bt\(["']([a-zA-Z][a-zA-Z0-9_.]+)["']\)` 只匹配合法的 i18n 键格式

### 为什么禁止 t() + 拼接

`{t("auth.username") + "不能为空"}` 这种模式无法被翻译。应使用：
- 完整键：`{t("validation.username_required")}`
- 或参数化键：`{t("validation.field_required", { field: t("auth.username") })}`

## 5. 运行方式

```bash
# 手动运行全部测试
npm test

# watch 模式（开发时）
npx vitest

# 运行单个测试文件
npx vitest run tests/i18n.test.ts
```

## 6. 扩展测试

在 `tests/` 目录下新增 `.test.ts` 文件即可，vitest 会自动收集：

```bash
tests/
  i18n.test.ts        # i18n 完整性
  api.test.ts          # API 端点测试（未来）
  auth.test.ts         # 认证逻辑测试（未来）
```
