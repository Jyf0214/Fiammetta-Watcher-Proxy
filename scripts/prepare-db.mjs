/**
 * prepare-db.mjs — 按 DB_TYPE 生成对应方言的 Prisma Client
 *
 * 功能：
 *   1. 根据 DB_TYPE 只生成需要的 Prisma Client（避免打包多余 WASM）
 *   2. 为未使用的方言生成空 stub 文件（webpack 静态分析需要 import 路径存在）
 *   3. MySQL/PG 方言额外执行 prisma db push 同步表结构
 *   4. D1 由 Python 部署脚本单独处理建表，不在此处 push
 *
 * 生成目录：
 *   - prisma/schema.d1.prisma    → src/generated/d1/   （或 stub）
 *   - prisma/schema.mysql.prisma → src/generated/mysql/ （或 stub）
 *   - prisma/schema.pg.prisma    → src/generated/pg/    （或 stub）
 *
 * 使用方式：
 *   DB_TYPE=d1 node scripts/prepare-db.mjs
 */

import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const GENERATED_ROOT = resolve(ROOT, "src", "generated");

/** 方言配置：schema 文件 + 输出目录 + db push 标记 */
const DIALECTS = {
  d1: { name: "D1", file: "prisma/schema.d1.prisma", dir: "d1", needsPush: false },
  tidb: { name: "MySQL", file: "prisma/schema.mysql.prisma", dir: "mysql", needsPush: true },
  pg: { name: "PostgreSQL", file: "prisma/schema.pg.prisma", dir: "pg", needsPush: true },
  hyperdrive: { name: "PostgreSQL", file: "prisma/schema.pg.prisma", dir: "pg", needsPush: true },
};

// ==================== 1. 推断 DB_TYPE ====================

function resolveDbType() {
  const dbType = process.env.DB_TYPE || "";
  if (DIALECTS[dbType]) return dbType;

  const url = process.env.DATABASE_URL || "";
  if (url.startsWith("mysql://") || url.startsWith("mysqls://")) return "tidb";
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) return "pg";

  return "d1";
}

const dbType = resolveDbType();
const dialect = DIALECTS[dbType];

console.log(`🔧 DB_TYPE: ${dbType}`);

// ==================== 2. 清理旧的生成产物 ====================

if (existsSync(GENERATED_ROOT)) {
  rmSync(GENERATED_ROOT, { recursive: true });
  console.log(`🧹 已清理旧的生成目录: src/generated/`);
}

// ==================== 3. 生成 Prisma Client（仅需要的方言） ====================

console.log(`📦 生成 ${dialect.name} Client (${dialect.file})`);

try {
  execSync(
    `npx prisma generate --schema=${dialect.file}`,
    {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL || "file:./placeholder.db",
      },
    }
  );
  console.log(`✅ ${dialect.name} Client 生成完成`);
} catch (err) {
  console.error(`❌ ${dialect.name} Client 生成失败:`, err.message);
  process.exit(1);
}

// ==================== 4. 为未使用的方言生成空 stub ====================

const STUB_CONTENT = `// 自动生成的空 stub — 未使用的 Prisma client 不打包到构建产物中
// 导出占位 PrismaClient，满足 lib/prisma.ts 的动态 import 类型检查
export class PrismaClient {
  constructor(..._args: unknown[]) {
    throw new Error("此方言未启用，请切换 DB_TYPE");
  }
}
`;

for (const [key, d] of Object.entries(DIALECTS)) {
  if (key === dbType || (dbType === "hyperdrive" && key === "pg")) continue;
  const stubDir = resolve(GENERATED_ROOT, d.dir);
  if (!existsSync(stubDir)) {
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(resolve(stubDir, "client.ts"), STUB_CONTENT);
    console.log(`📎 已生成 stub: src/generated/${d.dir}/client.ts`);
  }
}

// ==================== 5. MySQL / PostgreSQL db push ====================

if (dialect.needsPush) {
  const url = process.env.DATABASE_URL || "";
  if (url) {
    console.log(`⚙️  执行 prisma db push（${dialect.name}）...`);
    execSync(`npx prisma db push --schema=${dialect.file} --accept-data-loss`, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: url },
    });
    console.log(`✅ ${dialect.name} db push 完成`);
  } else {
    console.warn(`⚠️  ${dialect.name} 模式但未设置 DATABASE_URL，跳过 db push`);
  }
} else {
  console.log("ℹ️  D1 模式：跳过 db push（由 Python 部署脚本处理建表）");
}

console.log(`🎉 Prisma Client 就绪（${dialect.name}，stub 覆盖未使用的方言）`);
