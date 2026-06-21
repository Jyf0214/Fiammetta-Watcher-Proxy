#!/bin/sh
set -e

echo "[启动] 运行数据库迁移..."

# 根据 DATABASE_URL 协议自动选择 Prisma schema
if echo "$DATABASE_URL" | grep -qE '^mysql://'; then
  echo "[启动] 检测到 MySQL 数据库，使用 MySQL schema"
  cp prisma/mysql/schema.prisma prisma/schema.prisma
elif echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'; then
  echo "[启动] 检测到 PostgreSQL 数据库，使用 PostgreSQL schema"
else
  echo "[启动] 警告：DATABASE_URL 协议无法识别，默认使用 PostgreSQL"
fi

node ./node_modules/prisma/build/index.js db push
echo "[启动] 数据库迁移完成"

# 初始化管理员账户（通过环境变量）
echo "[启动] 初始化管理员账户..."
node scripts/init-admin.js || echo "[启动] 管理员初始化跳过或失败"

echo "[启动] 启动应用..."
exec node server.js
