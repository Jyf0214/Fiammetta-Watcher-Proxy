/**
 * 一次性数据迁移 — 合并 platforms.api_key 主字段到 apiKeys JSON 数组
 *
 * 背景：删除双 API 密钥格式（apiKey 单数主字段 + apiKeys JSON 数组）。
 * 本脚本在 prisma db push（drop api_key 列）之前由 prepare-db.mjs 调用，
 * 防止已有平台的主密钥在删列时丢失。
 *
 * 逻辑（幂等）：
 *   1. 读取全部平台的 api_key / api_keys
 *   2. apiKeys 规范化为命名对象数组 [{name, key, whitelisted}]
 *      （兼容字符串数组与对象数组格式）
 *   3. api_key 非空且不在数组中时，插入到数组首位（名称"主密钥"）
 *   4. 有变更才 UPDATE
 *
 * 容错：
 *   - api_key 列不存在（全新库或已迁移）→ 跳过并正常退出
 *   - platforms 表不存在（全新库，db push 尚未建表）→ 跳过并正常退出
 *   - DATABASE_URL 协议与 DB_TYPE 不匹配 → 跳过
 *   - hyperdrive 走 pg 直连迁移（origin 即 DATABASE_URL）
 *
 * 安全：只输出变更数量与行数，绝不输出密钥内容。
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ==================== 环境加载（与 prepare-db.mjs 一致） ====================

function loadDotEnv() {
  const envFile = resolve(ROOT, ".env");
  if (!existsSync(envFile)) return;
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

loadDotEnv();

function resolveDbType() {
  const dbType = process.env.DB_TYPE || "";
  if (["tidb", "mariadb", "pg", "hyperdrive"].includes(dbType)) return dbType;
  const url = process.env.DATABASE_URL || "";
  if (url.startsWith("mysql://") || url.startsWith("mysqls://")) return "tidb";
  if (url.startsWith("mariadb://")) return "mariadb";
  if (url.startsWith("postgresql://") || url.startsWith("postgres://")) return "pg";
  return "d1";
}

const dbType = resolveDbType();
const url =
  (dbType === "mariadb"
    ? process.env.MARIADB_URL
    : dbType === "pg" || dbType === "hyperdrive"
      ? process.env.PG_URL
      : process.env.TIDB_URL) ||
  process.env.DATABASE_URL ||
  "";

// D1 由 deploy/init.py 的 migrate_platform_keys_d1 处理，此处跳过
if (dbType === "d1") {
  console.log("[migrate-platform-keys] 跳过：D1 由部署脚本处理");
  process.exit(0);
}

// ==================== 密钥规范化 ====================

/** 规范化平台密钥为命名对象数组（兼容字符串/对象数组格式） */
function normalizeKeys(raw, legacyKey) {
  const named = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === "string") {
            if (item.trim()) {
              named.push({ name: `密钥${named.length + 1}`, key: item.trim() });
            }
          } else if (
            typeof item === "object" &&
            item !== null &&
            typeof item.key === "string"
          ) {
            const key = item.key.trim();
            if (key) {
              named.push({
                name:
                  typeof item.name === "string" && item.name.trim()
                    ? item.name.trim()
                    : `密钥${named.length + 1}`,
                key,
                ...(item.whitelisted === true ? { whitelisted: true } : {}),
              });
            }
          }
        }
      }
    } catch {
      // 无效 JSON，忽略
    }
  }
  if (legacyKey && legacyKey.trim() && !named.some((n) => n.key === legacyKey)) {
    named.unshift({ name: "主密钥", key: legacyKey.trim() });
  }
  return named;
}

/** 逐行迁移（连接必须保持打开，UPDATE 在 SELECT 同一连接上执行） */
async function migrateRows(rows, update) {
  let updated = 0;
  for (const row of rows) {
    const named = normalizeKeys(row.api_keys ?? null, row.api_key ?? null);
    const newRaw = JSON.stringify(named);
    if (newRaw === (row.api_keys ?? null)) continue;
    if (!named.length) continue;
    await update(row.id, newRaw);
    updated++;
  }
  console.log(`[migrate-platform-keys] 完成：共 ${rows.length} 个平台，合并/规范化 ${updated} 个`);
}

// ==================== 连接与迁移 ====================

async function main() {
  if (!url) {
    console.log("[migrate-platform-keys] 跳过：未设置 DATABASE_URL");
    process.exit(0);
  }

  if (dbType === "tidb") {
    const { connect } = await import("@tidbcloud/serverless");
    const conn = await connect({ url });
    try {
      const res = await conn.execute("SELECT id, api_key, api_keys FROM platforms");
      await migrateRows(res.rows || [], async (id, apiKeys) => {
        await conn.execute("UPDATE platforms SET api_keys = ? WHERE id = ?", [apiKeys, id]);
      });
    } finally {
      await conn.close();
    }
  } else if (dbType === "mariadb") {
    const mariadb = await import("mariadb");
    const pool = await mariadb.createPool({ uri: url, connectionLimit: 1 });
    try {
      const rows = await pool.query("SELECT id, api_key, api_keys FROM platforms");
      await migrateRows(rows, async (id, apiKeys) => {
        await pool.query("UPDATE platforms SET api_keys = ? WHERE id = ?", [apiKeys, id]);
      });
    } finally {
      await pool.end();
    }
  } else if (dbType === "pg" || dbType === "hyperdrive") {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      const res = await pool.query("SELECT id, api_key, api_keys FROM platforms");
      await migrateRows(res.rows || [], async (id, apiKeys) => {
        await pool.query("UPDATE platforms SET api_keys = $1 WHERE id = $2", [apiKeys, id]);
      });
    } finally {
      await pool.end();
    }
  } else {
    console.log("[migrate-platform-keys] 跳过：未知 DB_TYPE");
    process.exit(0);
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  // api_key 列已不存在（全新库或已迁移过）：正常跳过
  if (msg.includes("api_key") && /column|Column|field|Field/i.test(msg)) {
    console.log("[migrate-platform-keys] api_key 列不存在，跳过迁移（全新库或已迁移）");
    process.exit(0);
  }
  // platforms 表不存在（全新库，db push 尚未建表）：正常跳过
  if (/doesn't exist|does not exist|no such table|not found/i.test(msg)) {
    console.log("[migrate-platform-keys] platforms 表不存在，跳过迁移（全新库）");
    process.exit(0);
  }
  console.error("[migrate-platform-keys] 迁移失败:", msg);
  process.exit(1);
});
