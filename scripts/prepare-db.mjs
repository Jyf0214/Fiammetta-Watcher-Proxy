/**
 * prepare-db.mjs — 根据 DATABASE_URL 自动配置 Prisma schema + 依赖 + 数据库初始化
 *
 * 功能：
 *   1. 读取 DATABASE_URL 环境变量，推断数据库类型
 *   2. 修改 prisma/schema.prisma 的 provider 和 runtime
 *   3. 安装缺失的依赖（如 @prisma/adapter-pg）
 *   4. 执行 prisma generate 生成客户端
 *   5. MySQL / PostgreSQL 时自动执行 prisma db push 同步 schema
 *
 * 注意：D1 初始化由 GitHub Actions 工作流中的 Python 脚本处理，不在此处重复执行
 *
 * 使用方式：
 *   node scripts/prepare-db.mjs
 *
 * 环境变量：
 *   DATABASE_URL=mysql://...      → provider=mysql, 移除 cloudflare runtime
 *   DATABASE_URL=postgresql://... → provider=postgresql, 移除 cloudflare runtime
 *   无 DATABASE_URL 或 sqlite     → provider=sqlite, 保留 cloudflare runtime
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
let useCloudflareRuntime = true;

if (url.startsWith("mysql://") || url.startsWith("mysqls://")) {
  dbType = "mysql";
  provider = "mysql";
  useCloudflareRuntime = false;
} else if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
  dbType = "postgresql";
  provider = "postgresql";
  useCloudflareRuntime = false;
}

console.log(`🔍 检测到数据库类型: ${dbType}`);

// ============================================================
// 2. 修改 schema.prisma
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

// 处理 runtime
const runtimePattern = /^\s*runtime\s*=\s*"[^"]*"\s*$/m;
if (useCloudflareRuntime) {
  // D1/SQLite：确保 runtime = "cloudflare" 存在
  if (!runtimePattern.test(schema)) {
    // 在 generator 块内、output 行之后插入 runtime
    schema = schema.replace(
      /(generator\s+client\s*\{[^}]*?output\s*=\s*"[^"]*")/,
      '$1\n  runtime  = "cloudflare"',
    );
    schemaChanged = true;
    console.log("📝 已添加 runtime = \"cloudflare\"");
  }
} else {
  // MySQL/PG：移除 runtime 行（使用默认 Node.js runtime）
  if (runtimePattern.test(schema)) {
    const currentRuntime = schema.match(runtimePattern)[0].trim();
    // 移除 runtime 行及其后的空行，避免残留空行
    schema = schema.replace(/\n?\s*runtime\s*=\s*"[^"]*"\s*\n?/, "\n");
    schemaChanged = true;
    console.log(`📝 已移除 ${currentRuntime}（非 Cloudflare 环境不需要）`);
  }
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
    // 确保 prisma generate 能找到 schema
    DATABASE_URL: url || "file:./placeholder.db",
  },
});
console.log("✅ prisma generate 完成");

// ============================================================
// 5. 数据库初始化（MySQL / PostgreSQL 自动同步 schema）
// ============================================================

if (dbType !== "sqlite") {
  console.log("⚙️  执行 prisma db push（同步 schema 到数据库）...");
  execSync("npx prisma db push --skip-generate", {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
  console.log("✅ prisma db push 完成");
}

console.log(`🎉 数据库配置就绪（${dbType}）`);
