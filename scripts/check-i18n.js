#!/usr/bin/env node
/**
 * i18n 翻译完整性校验
 * 检查 zh.json 和 en.json 的键是否完全一致，值是否为空
 */
const fs = require("fs");
const path = require("path");

const zhPath = path.resolve(__dirname, "../messages/zh.json");
const enPath = path.resolve(__dirname, "../messages/en.json");

const zh = JSON.parse(fs.readFileSync(zhPath, "utf-8"));
const en = JSON.parse(fs.readFileSync(enPath, "utf-8"));

function flatten(obj, prefix = "") {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "object" && val !== null) {
      Object.assign(result, flatten(val, fullKey));
    } else {
      result[fullKey] = val;
    }
  }
  return result;
}

const zhFlat = flatten(zh);
const enFlat = flatten(en);

const zhKeys = new Set(Object.keys(zhFlat));
const enKeys = new Set(Object.keys(enFlat));

let errors = 0;

// 检查 zh 中有但 en 中没有的键
const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
if (missingInEn.length > 0) {
  console.error(`❌ en.json 缺少 ${missingInEn.length} 个键：`);
  missingInEn.forEach((k) => console.error(`   - ${k}`));
  errors += missingInEn.length;
}

// 检查 en 中有但 zh 中没有的键
const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
if (missingInZh.length > 0) {
  console.error(`❌ zh.json 缺少 ${missingInZh.length} 个键：`);
  missingInZh.forEach((k) => console.error(`   - ${k}`));
  errors += missingInZh.length;
}

// 检查空值
let emptyCount = 0;
for (const [key, val] of Object.entries(zhFlat)) {
  if (!val || (typeof val === "string" && val.trim() === "")) {
    console.error(`⚠️  zh.json 值为空: ${key}`);
    emptyCount++;
  }
}
for (const [key, val] of Object.entries(enFlat)) {
  if (!val || (typeof val === "string" && val.trim() === "")) {
    console.error(`⚠️  en.json 值为空: ${key}`);
    emptyCount++;
  }
}

// 只检查前端 .tsx 文件（排除 API 路由、hooks、lib 等非 UI 文件）
const srcDir = path.resolve(__dirname, "../src");
// 只扫描这些目录下的 .tsx 文件
const scanDirs = ["app/admin", "app/page.tsx", "components"];
const tKeyRegex = /\bt\(["']([a-zA-Z][a-zA-Z0-9_.]+)["']\)/g;
const srcFiles = [];

function walkDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(full);
    else if (/\.tsx$/.test(entry.name)) srcFiles.push(full);
  }
}

// 只扫描包含 useTranslation 的 .tsx 文件
for (const dir of scanDirs) {
  const fullPath = path.join(srcDir, dir);
  if (fs.existsSync(fullPath)) {
    if (fs.statSync(fullPath).isDirectory()) {
      walkDir(fullPath);
    } else {
      srcFiles.push(fullPath);
    }
  }
}

// 过滤：只保留实际导入了 useTranslation 的文件
const filesWithI18n = srcFiles.filter((f) => {
  const content = fs.readFileSync(f, "utf-8");
  return (
    content.includes('from "react-i18next"') ||
    content.includes("from 'react-i18next'") ||
    content.includes('from "@/lib/i18n"') ||
    content.includes("from '@/lib/i18n'")
  );
});

let missingKeyInSrc = 0;
for (const file of filesWithI18n) {
  const content = fs.readFileSync(file, "utf-8");
  let match;
  while ((match = tKeyRegex.exec(content)) !== null) {
    const key = match[1];
    // 跳过带变量插值的键（如 pagination_total 中的 {count}）
    const cleanKey = key.split("{")[0];
    if (!zhFlat[cleanKey] && !enFlat[cleanKey]) {
      const rel = path.relative(path.resolve(__dirname, ".."), file);
      console.error(`❌ 源代码引用不存在的 i18n 键: ${key} (${rel})`);
      missingKeyInSrc++;
    }
  }
}

// 汇总
console.log("");
console.log(`📊 i18n 校验结果：`);
console.log(`   zh.json: ${zhKeys.size} 个键`);
console.log(`   en.json: ${enKeys.size} 个键`);
console.log(`   缺失键: ${errors} 个`);
console.log(`   空值: ${emptyCount} 个`);
console.log(`   源代码引用缺失键: ${missingKeyInSrc} 个`);

if (errors > 0 || missingKeyInSrc > 0) {
  console.error("");
  console.error("❌ i18n 校验失败，请修复后重试");
  process.exit(1);
}

if (emptyCount > 0) {
  console.warn("");
  console.warn("⚠️  存在空值，建议补充翻译");
}

console.log("✅ i18n 校验通过");
process.exit(0);
