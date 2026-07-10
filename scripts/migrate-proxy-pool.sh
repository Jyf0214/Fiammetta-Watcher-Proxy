#!/bin/sh
# 一次性数据迁移：代理平台绑定 → 代理池
# 在 prisma db push 之前执行，将 proxies.platformId 数据迁移到 proxy_pools + proxies.poolId
# 幂等：已迁移则跳过

set -e

echo "[migration] 检查是否需要代理池数据迁移..."

# 运行迁移脚本（独立 JS 文件，避免 shell 反引号冲突）
if node scripts/migrate-proxy-pool.js; then
  echo "[migration] 代理池数据迁移完成"
else
  echo "[migration] 代理池数据迁移跳过或失败（非致命）"
fi
