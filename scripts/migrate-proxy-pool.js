/**
 * 一次性数据迁移：代理平台绑定 → 代理池
 * 由 migrate-proxy-pool.sh 调用
 */

const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto");
const prisma = new PrismaClient();

const MIGRATION_KEY = "migration:proxy_pool_v1";

async function markDone(value) {
  const id = crypto.randomBytes(12).toString("base64url");
  await prisma.$executeRawUnsafe(
    "INSERT INTO configs (id, `key`, value, updatedAt) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE value = ?, updatedAt = NOW()",
    id,
    MIGRATION_KEY,
    value,
    value
  );
}

async function main() {
  // 检查是否已迁移
  try {
    const existing = await prisma.$queryRawUnsafe(
      "SELECT 1 FROM configs WHERE `key` = ? LIMIT 1",
      MIGRATION_KEY
    );
    if (existing && existing.length > 0) {
      console.log("[migration] 代理池迁移已完成，跳过");
      return;
    }
  } catch {
    // Config 表可能不存在，继续
  }

  console.log("[migration] 开始代理池数据迁移...");

  // 1. 读取绑定平台的代理
  let proxies;
  try {
    proxies = await prisma.$queryRawUnsafe(
      "SELECT id, address, platformId FROM proxies WHERE platformId IS NOT NULL"
    );
  } catch {
    console.log("[migration] proxies 表无 platformId 列，跳过");
    return;
  }

  if (!proxies || proxies.length === 0) {
    console.log("[migration] 无代理绑定数据，跳过");
    await markDone("no_data");
    return;
  }

  console.log("[migration] 发现 " + proxies.length + " 个绑定平台的代理");

  // 2. 收集唯一 platformId
  const platformIds = [...new Set(proxies.map((p) => p.platformId).filter(Boolean))];

  // 3. 读取平台名称
  const placeholders = platformIds.map(() => "?").join(",");
  const platforms = await prisma.$queryRawUnsafe(
    "SELECT id, name FROM platforms WHERE id IN (" + placeholders + ")",
    ...platformIds
  );
  const nameMap = new Map(platforms.map((p) => [p.id, p.name]));

  // 4. 为每个平台创建代理池
  const poolMap = {};
  for (const pid of platformIds) {
    const pname = nameMap.get(pid) || "pool-" + pid.slice(0, 8);
    const poolName = pname + " 池";

    // 检查是否已存在
    let existing;
    try {
      existing = await prisma.$queryRawUnsafe(
        "SELECT id FROM proxy_pools WHERE name = ? LIMIT 1",
        poolName
      );
    } catch {
      // proxy_pools 表可能还不存在
    }

    if (existing && existing.length > 0) {
      poolMap[pid] = existing[0].id;
    } else {
      const id = crypto.randomBytes(12).toString("base64url");
      const now = new Date().toISOString();
      await prisma.$executeRawUnsafe(
        "INSERT INTO proxy_pools (id, name, enabled, createdAt, updatedAt) VALUES (?, ?, true, ?, ?)",
        id,
        poolName,
        now,
        now
      );
      poolMap[pid] = id;
      console.log("[migration] 创建代理池: " + poolName);
    }
  }

  // 5. 更新代理的 poolId
  let updated = 0;
  for (const proxy of proxies) {
    const poolId = poolMap[proxy.platformId];
    if (!poolId) continue;
    await prisma.$executeRawUnsafe(
      "UPDATE proxies SET poolId = ? WHERE id = ?",
      poolId,
      proxy.id
    );
    updated++;
  }

  console.log("[migration] 数据迁移完成: " + platformIds.length + " 个代理池, " + updated + " 个代理");

  // 6. 删除 platformId 列
  try {
    await prisma.$executeRawUnsafe("ALTER TABLE proxies DROP COLUMN platformId");
    console.log("[migration] 已删除 proxies.platformId 列");
  } catch (e) {
    console.warn("[migration] 删除 platformId 列失败（可能已删除）:", e.message);
  }

  await markDone(JSON.stringify({ pools: platformIds.length, proxies: updated }));
}

main()
  .catch((e) => {
    console.error("[migration] 迁移失败:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
