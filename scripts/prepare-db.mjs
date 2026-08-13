/**
 * prepare-db.mjs — 按 DB_TYPE 生成对应方言的 Prisma Client
 *
 * 功能：
 *   1. 根据 DB_TYPE 只生成需要的 Prisma Client（避免打包多余 WASM）
 *   2. 为未使用的方言生成空 stub 文件（webpack 静态分析需要 import 路径存在）
 *   3. 自动读取 .env.local（优先，本地开发库）与 .env（不覆盖已有环境变量；EdgeOne CLI 构建期会把项目环境变量拉取到 .env）
 *   4. MySQL/MariaDB/PostgreSQL 方言在 CI 环境（CI=true，含 EdgeOne/Vercel/Cloudflare 构建）且 DATABASE_URL 协议匹配时
 *      自动执行 prisma db push 同步表结构；本地默认不 push，需要时设置 DB_PUSH=1
 *      （npm run db:dev 会在 .env.local 写入 DB_PUSH=1，本地开发自动同步表结构）
 *   5. D1 由 Python 部署脚本单独处理建表，不在此处 push
 *
 * 生成目录：
 *   - prisma/schema.d1.prisma      → src/generated/d1/       （或 stub）
 *   - prisma/schema.mysql.prisma   → src/generated/mysql/    （或 stub，TiDB）
 *   - prisma/schema.mariadb.prisma → src/generated/mariadb/  （或 stub）
 *   - prisma/schema.pg.prisma      → src/generated/pg/       （或 stub）
 *
 * 使用方式：
 *   DB_TYPE=d1 node scripts/prepare-db.mjs
 *   无 DB_TYPE/DATABASE_URL 时默认 d1（本地开发用 npm run db:dev 在 .env.local
 *   显式写入 DB_TYPE=pg + DATABASE_URL，切换到嵌入式 PostgreSQL）
 */

import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const GENERATED_ROOT = resolve(ROOT, "src", "generated");

/** 方言配置：schema 文件 + 输出目录 + db push 标记 */
const DIALECTS = {
  d1: { name: "D1", file: "prisma/schema.d1.prisma", dir: "d1", needsPush: false },
  tidb: { name: "MySQL", file: "prisma/schema.mysql.prisma", dir: "mysql", needsPush: true },
  mariadb: { name: "MariaDB", file: "prisma/schema.mariadb.prisma", dir: "mariadb", needsPush: true },
  pg: { name: "PostgreSQL", file: "prisma/schema.pg.prisma", dir: "pg", needsPush: true },
  hyperdrive: { name: "PostgreSQL", file: "prisma/schema.pg.prisma", dir: "pg", needsPush: true },
};

// ==================== 1. 加载 .env + 推断 DB_TYPE ====================

/**
 * 读取项目根目录 .env.local（优先）与 .env（不覆盖已存在的环境变量）。
 * .env.local 由 scripts/dev-postgres.mjs 写入（本地开发库连接），优先级高于 .env；
 * EdgeOne CLI 部署时会把项目环境变量拉取到 .env，构建期依赖它拿到 DB_TYPE/DATABASE_URL。
 */
function loadDotEnv() {
  for (const envFile of [resolve(ROOT, ".env.local"), resolve(ROOT, ".env")]) {
    if (!existsSync(envFile)) continue;
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadDotEnv();

function resolveDbType() {
  const dbType = process.env.DB_TYPE || "";
  if (DIALECTS[dbType]) return dbType;

  const url = process.env.DATABASE_URL || "";
  if (url.startsWith("mysql://") || url.startsWith("mysqls://")) return "tidb";
  if (url.startsWith("mariadb://")) return "mariadb";
  if ((process.env.MARIADB_URL || "").startsWith("mariadb://")) return "mariadb";
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) return "pg";

  return "d1";
}

const dbType = resolveDbType();
const dialect = DIALECTS[dbType];

if (
  dbType === "d1" &&
  !process.env.DB_TYPE &&
  !process.env.DATABASE_URL &&
  (process.env.DEPLOY_PLATFORM === "edgeone" || process.env.DEPLOY_PLATFORM === "vercel")
) {
  console.warn("! 未检测到 DB_TYPE/DATABASE_URL，已默认 d1——EdgeOne/Vercel 部署必须配置 DB_TYPE 与 DATABASE_URL，否则运行时无法连接数据库");
}

console.log(`DB_TYPE: ${dbType}`);

// ==================== 2. 清理旧的生成产物 ====================

if (existsSync(GENERATED_ROOT)) {
  rmSync(GENERATED_ROOT, { recursive: true });
  console.log(`已清理旧的生成目录: src/generated/`);
}

// ==================== 3. 生成 Prisma Client（仅需要的方言） ====================

console.log(`生成 ${dialect.name} Client (${dialect.file})`);

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
  console.log(`✓ ${dialect.name} Client 生成完成`);
} catch (err) {
  console.error(`✗ ${dialect.name} Client 生成失败:`, err.message);
  process.exit(1);
}

// ==================== 4. 为未使用的方言生成空 stub ====================

/**
 * stub 转发当前启用方言（dialect.dir）的真实 client 类型。
 * lib/prisma.ts 对 d1 方言做了静态类型导入（import type { PrismaClient }、
 * export type { Prisma }），占位对象缺少 Prisma 命名空间与模型方法类型，
 * 会导致 DB_TYPE≠d1 时构建类型检查失败（如 pg 本地开发）。各方言 schema
 * 结构一致，转发真实类型即可满足类型检查；type-only 导入在编译期擦除，
 * 不会把真实 client 打进未启用方言的模块。
 */
function buildStubContent(realDir) {
  return `// 自动生成的空 stub — 未使用的 Prisma client 不打包到构建产物中
// 类型转发自当前启用方言（${realDir}/client，各方言 schema 结构一致），
// 满足 lib/prisma.ts 对 d1 方言的静态类型导入
export { PrismaClient } from "../${realDir}/client";
export type { Prisma } from "../${realDir}/client";
`;
}

for (const [key, d] of Object.entries(DIALECTS)) {
  if (key === dbType || (dbType === "hyperdrive" && key === "pg")) continue;
  const stubDir = resolve(GENERATED_ROOT, d.dir);
  if (!existsSync(stubDir)) {
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(resolve(stubDir, "client.ts"), buildStubContent(dialect.dir));
    console.log(`已生成 stub: src/generated/${d.dir}/client.ts（转发 ${dialect.dir} 类型）`);
  }
}

// ==================== 5. MySQL / MariaDB / PostgreSQL db push ====================

if (dialect.needsPush) {
  // 运行时 lib/prisma.ts 的 url 取 MARIADB_URL || DATABASE_URL，建表必须保持一致
  const url = process.env.MARIADB_URL || process.env.DATABASE_URL || "";
  // 仅当 DATABASE_URL 协议与方言匹配时才 push，防止占位串（file:./placeholder.db）误推
  let schemes = [];
  if (dbType === "tidb") schemes = ["mysql://", "mysqls://"];
  else if (dbType === "mariadb") schemes = ["mariadb://"];
  else schemes = ["postgresql://", "postgres://"];
  const isRemote = schemes.some((scheme) => url.startsWith(scheme));
  // CI 环境（EdgeOne/Vercel/GitHub Actions 均带 CI=true）自动 push；本地默认不 push，
  // 防止开发者 npm install 时意外对真实数据库执行破坏性 --accept-data-loss
  const shouldPush = isRemote && (process.env.CI === "true" || process.env.DB_PUSH === "1");
  if (shouldPush) {
    // 平台密钥迁移：db push 会 drop api_key 列，必须先合并主密钥到 apiKeys
    console.log("执行平台密钥迁移（合并 api_key → apiKeys）...");
    execSync(`node scripts/migrate-platform-keys.mjs`, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env },
    });
    console.log(` 执行 prisma db push（${dialect.name}）...`);
    execSync(`npx prisma db push --schema=${dialect.file} --accept-data-loss`, {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: url },
    });
    console.log(`✓ ${dialect.name} db push 完成`);
  } else if (isRemote) {
    console.warn(`! ${dialect.name} 模式且 DATABASE_URL 匹配，但非 CI 环境且未设置 DB_PUSH=1，跳过 db push（CI 自动执行；本地如需同步表结构请设置 DB_PUSH=1）`);
  } else if (url) {
    console.warn(`! ${dialect.name} 模式但 DATABASE_URL 协议不是 ${schemes.join(" / ")}，跳过 db push`);
  } else {
    console.warn(`! ${dialect.name} 模式但未设置 DATABASE_URL，跳过 db push`);
  }
} else {
  console.log("D1 模式：跳过 db push（由 Python 部署脚本处理建表）");
}

console.log(`✓ Prisma Client 就绪（${dialect.name}，stub 覆盖未使用的方言）`);
