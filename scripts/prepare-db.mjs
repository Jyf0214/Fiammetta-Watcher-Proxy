/**
 * prepare-db.mjs — 根据 DATABASE_URL 自动配置 Prisma schema + 依赖 + 数据库初始化
 *
 * 功能：
 *   1. 读取 DATABASE_URL 环境变量，推断数据库类型
 *   2. Cloudflare Pages 构建时始终保留 provider=sqlite（D1 通过 binding 连接）
 *   3. 非 Cloudflare 环境下根据 DATABASE_URL 切换 provider
 *   4. 确保 runtime = "cloudflare" 始终存在（部署到 CF 必须）
 *   5. 安装缺失的依赖（如 @prisma/adapter-pg）
 *   6. 执行 prisma generate 生成客户端
 *   7. 非 CF 环境下 MySQL / PostgreSQL 自动执行 prisma db push 同步 schema
 *
 * 注意：
 *   - runtime = "cloudflare" 是 Cloudflare 部署必需，与数据库类型无关
 *   - Cloudflare Pages 始终通过 D1 binding 连接数据库，不使用 DATABASE_URL 连接
 *   - Prisma 7 的 provider 是编译时常量，构建时切换 provider 会导致运行时 adapter 不匹配
 *   - D1 初始化由 GitHub Actions 工作流中的 Python 脚本处理，不在此处重复执行
 *
 * 使用方式：
 *   node scripts/prepare-db.mjs
 *
 * 环境变量：
 *   DATABASE_URL=mysql://...      → 非 CF 环境: provider=mysql; CF 环境: 保持 sqlite
 *   DATABASE_URL=postgresql://... → 非 CF 环境: provider=postgresql; CF 环境: 保持 sqlite
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
// Cloudflare Pages 构建时跳过 provider 切换 —— D1 通过 binding 连接，
// 不依赖 DATABASE_URL，且 Prisma 7 的 provider 是编译时常量，
// 构建时切换会导致运行时 adapter 不匹配。
const isCfBuild = process.env.CF_BUILD === "true";

let dbType = "sqlite";
let provider = "sqlite";

if (!isCfBuild) {
  if (url.startsWith("mysql://") || url.startsWith("mysqls://")) {
    dbType = "mysql";
    provider = "mysql";
  } else if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
    dbType = "postgresql";
    provider = "postgresql";
  }
}

if (isCfBuild) {
  console.log("🔍 Cloudflare 构建模式 — 跳过 provider 切换，始终使用 sqlite（D1）");
} else {
  console.log(`🔍 检测到数据库类型: ${dbType}`);
}

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

if (dbType !== "sqlite" && !isCfBuild) {
  console.log("⚙️  执行 prisma db push（同步 schema 到数据库）...");
  execSync("npx prisma db push", {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
  console.log("✅ prisma db push 完成");
}

console.log(`🎉 数据库配置就绪（${dbType}）`);
