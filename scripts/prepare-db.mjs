/**
 * prepare-db.mjs — 根据 DATABASE_URL 自动配置 Prisma schema + 依赖 + 数据库初始化
 *
 * 功能：
 *   1. 读取 DATABASE_URL 环境变量，推断数据库类型
 *   2. 修改 prisma/schema.prisma 的 datasource provider
 *   3. 确保 runtime = "cloudflare" 始终存在（部署到 CF 必须）
 *   4. 安装缺失的依赖（如 @prisma/adapter-pg）
 *   5. 执行 prisma generate 生成客户端
 *   6. MySQL / PostgreSQL 时自动执行 prisma db push 同步 schema
 *
 * 注意：
 *   - runtime = "cloudflare" 是 Cloudflare 部署必需，与数据库类型无关
 *   - D1 初始化由 GitHub Actions 工作流中的 Python 脚本处理，不在此处重复执行
 *
 * 使用方式：
 *   node scripts/prepare-db.mjs
 *
 * 环境变量：
 *   DATABASE_URL=mysql://...      → provider=mysql
 *   DATABASE_URL=postgresql://... → provider=postgresql
 *   无 DATABASE_URL 或 sqlite     → provider=sqlite
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCHEMA_PATH = resolve(ROOT, "prisma/schema.prisma");

// ============================================================
// 1. 推断数据库类型
// ============================================================

const url = process.env.DATABASE_URL || "";

let dbType = "sqlite";
let provider = "sqlite";

if (url.startsWith("mysql://") || url.startsWith("mysqls://")) {
  dbType = "mysql";
  provider = "mysql";
} else if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
  dbType = "postgresql";
  provider = "postgresql";
}

console.log(`🔍 检测到数据库类型: ${dbType}`);

// ============================================================
// 2. 修改 schema.prisma（仅 datasource provider）
// ============================================================

let schema = readFileSync(SCHEMA_PATH, "utf-8");
let schemaChanged = false;

// 替换 datasource 块中的 provider（不匹配 generator 块的 provider）
const datasourceProviderPattern = /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"[^"]*"/;
const newProvider = `"${provider}"`;
const match = schema.match(datasourceProviderPattern);
if (!match) {
  console.error("❌ schema.prisma 的 datasource 块中未找到 provider 配置");
  process.exit(1);
}
const currentProvider = match[0].slice(match[1].length);
if (currentProvider !== newProvider) {
  schema = schema.replace(datasourceProviderPattern, `$1${newProvider}`);
  schemaChanged = true;
  console.log(`📝 provider: ${currentProvider} → ${newProvider}`);
}

// runtime = "cloudflare" 始终保留（Cloudflare 部署必须，与数据库类型无关）
const runtimePattern = /^\s*runtime\s*=\s*"[^"]*"\s*$/m;
if (!runtimePattern.test(schema)) {
  // generator 块内没有 runtime 行，插入
  schema = schema.replace(
    /(generator\s+client\s*\{[^}]*?output\s*=\s*"[^"]*")/,
    '$1\n  runtime  = "cloudflare"',
  );
  schemaChanged = true;
  console.log("📝 已添加 runtime = \"cloudflare\"");
}

if (schemaChanged) {
  writeFileSync(SCHEMA_PATH, schema, "utf-8");
  console.log("✅ schema.prisma 已更新");
} else {
  console.log("✅ schema.prisma 无需修改");
}

// ============================================================
// 3. 安装缺失依赖
// ============================================================

const depsToInstall = [];

if (dbType === "postgresql") {
  // PostgreSQL 需要 @prisma/adapter-pg
  try {
    await import("@prisma/adapter-pg");
  } catch {
    depsToInstall.push("@prisma/adapter-pg");
  }
}

if (depsToInstall.length > 0) {
  console.log(`📦 安装缺失依赖: ${depsToInstall.join(", ")}`);
  execSync(`npm install ${depsToInstall.join(" ")}`, {
    cwd: ROOT,
    stdio: "inherit",
  });
  console.log("✅ 依赖安装完成");
} else {
  console.log("✅ 依赖已就绪");
}

// ============================================================
// 4. prisma generate
// ============================================================

console.log("⚙️  执行 prisma generate...");
execSync("npx prisma generate", {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: url || "file:./placeholder.db",
  },
});
console.log("✅ prisma generate 完成");

// ============================================================
// 5. 数据库初始化（MySQL / PostgreSQL 自动同步 schema）
// ============================================================

if (dbType !== "sqlite") {
  console.log("⚙️  执行 prisma db push（同步 schema 到数据库）...");
  execSync("npx prisma db push", {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
  console.log("✅ prisma db push 完成");
}

console.log(`🎉 数据库配置就绪（${dbType}）`);
