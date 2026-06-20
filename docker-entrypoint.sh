#!/bin/sh
set -e

echo "[启动] 运行数据库迁移..."
npx prisma db push
echo "[启动] 数据库迁移完成"

echo "[启动] 启动应用..."
exec node server.js
