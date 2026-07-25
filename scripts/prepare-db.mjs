/**
 * prepare-db.mjs — 多方言 Prisma Schema 生成
 *
 * 功能：
 *   1. 构建时生成全部三个方言的 Prisma Client（D1 / MySQL / PG）
 *   2. 根据 DB_TYPE 环境变量决定是否执行 prisma db push（MySQL/PG 需要）
 *   3. D1 由 wrangler CLI 或 Python 部署脚本单独处理，不在此处 push
 *
 * 生成目录：
 *   - prisma/schema.d1.prisma    → src/generated/d1/
 *   - prisma/schema.mysql.prisma → src/generated/mysql/
 *   - prisma/schema.pg.prisma    → src/generated/pg/
 *
 * 使用方式：
 *   node scripts/prepare-db.mjs
 */

import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const SCHEMAS = [
  { name: "D1", file: "prisma/schema.d1.prisma", dialect: "d1" },
  { name: "MySQL", file: "prisma/schema.mysql.prisma", dialect: "mysql" },
  { name: "PostgreSQL", file: "prisma/schema.pg.prisma", dialect: "pg" },
];

// ==================== 1. 生成三个方言的 Prisma Client ====================

for (const schema of SCHEMAS) {
  console.log(`⚙️  生成 ${schema.name} Client (${schema.file})...`);
  try {
    execSync(
      `npx prisma generate --schema=${schema.file}`,
      {
        cwd: ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL || "file:./placeholder.db",
        },
      }
    );
    console.log(`✅ ${schema.name} Client 生成完成`);
  } catch (err) {
    console.error(`❌ ${schema.name} Client 生成失败:`, err.message);
    // 非 D1 方言生成失败不阻断构建（可能缺少依赖）
    if (schema.dialect === "d1") {
      process.exit(1);
    }
    console.warn(`⚠️  跳过 ${schema.name}（可后续安装依赖后重新生成）`);
  }
}

// ==================== 2. MySQL / PostgreSQL db push ====================

const dbType = process.env.DB_TYPE || "";
const url = process.env.DATABASE_URL || "";

if (dbType === "tidb" || url.startsWith("mysql://") || url.startsWith("mysqls://")) {
  console.log("⚙️  执行 prisma db push（MySQL）...");
  execSync("npx prisma db push --schema=prisma/schema.mysql.prisma", {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
  console.log("✅ MySQL db push 完成");
} else if (dbType === "pg" || dbType === "hyperdrive" || url.startsWith("postgresql://") || url.startsWith("postgres://")) {
  console.log("⚙️  执行 prisma db push（PostgreSQL）...");
  execSync("npx prisma db push --schema=prisma/schema.pg.prisma", {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
  console.log("✅ PostgreSQL db push 完成");
} else {
  console.log("ℹ️  D1 模式：跳过 db push（由 wrangler CLI 处理）");
}

console.log("🎉 多方言 Prisma 配置就绪");
