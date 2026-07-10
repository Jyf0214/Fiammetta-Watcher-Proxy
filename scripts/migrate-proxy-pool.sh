#!/bin/sh
# 一次性数据迁移：代理平台绑定 → 代理池
# 在 prisma db push 之前执行，将 proxies.platformId 数据迁移到 proxy_pools + proxies.poolId
# 幂等：已迁移则跳过

set -e

MIGRATION_KEY="migration:proxy_pool_v1"

echo "[migration] 检查是否需要代理池数据迁移..."

# 检查是否已迁移（Config 表可能还不存在，用 || true 容错）
MIGRATED=$(node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.config.findUnique({ where: { key: '$MIGRATION_KEY' } })
  .then(r => { console.log(r ? 'yes' : 'no'); })
  .catch(() => { console.log('no'); })
  .finally(() => p.\$disconnect());
" 2>/dev/null || echo "no")

if [ "$MIGRATED" = "yes" ]; then
  echo "[migration] 代理池迁移已完成，跳过"
  exit 0
fi

echo "[migration] 开始代理池数据迁移..."

# 使用 Node.js 执行数据迁移（直接操作数据库，不依赖 Prisma schema）
node -e "
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function migrate() {
  // 1. 检查 proxies 表是否有 platformId 列
  let proxies;
  try {
    proxies = await prisma.\$queryRaw\`
      SELECT id, address, platformId FROM proxies WHERE platformId IS NOT NULL
    \`;
  } catch (e) {
    // 列不存在，可能是新库
    console.log('[migration] proxies 表无 platformId 列，跳过');
    return;
  }

  if (!proxies || proxies.length === 0) {
    console.log('[migration] 无代理绑定数据，跳过');
    await markDone(prisma, 'no_data');
    return;
  }

  console.log('[migration] 发现 ' + proxies.length + ' 个绑定平台的代理');

  // 2. 收集唯一 platformId
  const platformIds = [...new Set(proxies.map(p => p.platformId).filter(Boolean))];

  // 3. 读取平台名称
  const platforms = await prisma.\$queryRaw\`
    SELECT id, name FROM platforms WHERE id IN (\${platformIds.join(',')})
  \`;
  const nameMap = new Map(platforms.map(p => [p.id, p.name]));

  // 4. 为每个平台创建代理池
  const poolMap = {};
  for (const pid of platformIds) {
    const pname = nameMap.get(pid) || ('pool-' + pid.slice(0, 8));
    const poolName = pname + ' 池';

    // 检查是否已存在
    let pool;
    try {
      const existing = await prisma.\$queryRaw\`
        SELECT id FROM proxy_pools WHERE name = \${poolName} LIMIT 1
      \`;
      if (existing && existing.length > 0) {
        pool = existing[0];
      }
    } catch {
      // proxy_pools 表可能还不存在
    }

    if (!pool) {
      const id = require('crypto').randomBytes(12).toString('base64url');
      const now = new Date().toISOString();
      await prisma.\$executeRaw\`
        INSERT INTO proxy_pools (id, name, enabled, createdAt, updatedAt)
        VALUES (\${id}, \${poolName}, true, \${now}, \${now})
      \`;
      pool = { id };
      console.log('[migration] 创建代理池: ' + poolName);
    }
    poolMap[pid] = pool.id;
  }

  // 5. 更新代理的 poolId
  let updated = 0;
  for (const proxy of proxies) {
    const poolId = poolMap[proxy.platformId];
    if (!poolId) continue;
    await prisma.\$executeRaw\`
      UPDATE proxies SET poolId = \${poolId} WHERE id = \${proxy.id}
    \`;
    updated++;
  }

  console.log('[migration] 迁移完成: ' + platformIds.length + ' 个代理池, ' + updated + ' 个代理');

  // 6. 删除 platformId 列（数据已迁移到 poolId，删除后 prisma db push 不再报数据丢失）
  try {
    await prisma.\$executeRaw\`ALTER TABLE proxies DROP COLUMN platformId\`;
    console.log('[migration] 已删除 proxies.platformId 列');
  } catch (e) {
    console.warn('[migration] 删除 platformId 列失败（可能已删除）:', e.message);
  }

  await markDone(prisma, JSON.stringify({ pools: platformIds.length, proxies: updated }));
}

async function markDone(prisma, value) {
  const id = require('crypto').randomBytes(12).toString('base64url');
  try {
    await prisma.\$executeRaw\`
      INSERT INTO configs (id, \`key\`, value, updatedAt)
      VALUES (\${id}, '${MIGRATION_KEY}', \${value}, NOW())
      ON DUPLICATE KEY UPDATE value = \${value}, updatedAt = NOW()
    \`;
  } catch (e) {
    console.warn('[migration] 标记迁移完成失败:', e.message);
  }
}

migrate()
  .then(() => prisma.\$disconnect())
  .catch(e => { console.error('[migration] 失败:', e.message); prisma.\$disconnect(); process.exit(1); });
" 2>&1

echo "[migration] 代理池数据迁移完成"
