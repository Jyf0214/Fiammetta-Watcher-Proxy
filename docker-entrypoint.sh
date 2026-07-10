#!/bin/sh
set -e

echo "[启动] 运行数据库迁移..."

# 根据 DATABASE_URL 协议动态切换 Prisma schema 中的 provider（单一 schema 文件，不拷贝）
if echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'; then
  echo "[启动] 检测到 PostgreSQL 数据库，动态切换 provider"
  sed -i 's/provider = "mysql"/provider = "postgresql"/' prisma/schema.prisma
elif echo "$DATABASE_URL" | grep -qE '^mysql://'; then
  echo "[启动] 检测到 MySQL 数据库，保持默认 provider"
else
  echo "[启动] 警告：DATABASE_URL 协议无法识别，默认使用 MySQL"
fi

if ! node ./node_modules/prisma/build/index.js db push; then
  echo "[错误] 数据库迁移失败，请检查 DATABASE_URL 配置和数据库连接状态"
  exit 1
fi
echo "[启动] 数据库迁移完成"

# 初始化管理员账户（通过环境变量）
echo "[启动] 初始化管理员账户..."
if ! node scripts/init-admin.js; then
  echo "[警告] 管理员账户初始化失败，可能未设置 ADMIN_USERNAME 或 ADMIN_PASSWORD 环境变量"
fi

echo "[启动] 启动应用..."
exec node server.js
