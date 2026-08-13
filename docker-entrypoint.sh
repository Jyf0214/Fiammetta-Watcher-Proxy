#!/bin/sh
set -e

# ==================== 数据库配置检查 ====================
# canary 没有 /setup 引导页（那是 stable 分支的功能），数据库连接串是硬性要求
if [ -z "$DATABASE_URL" ]; then
  echo "[启动] 错误：未设置 DATABASE_URL 环境变量"
  echo "[启动] Docker 部署必须配置 DB_TYPE 与 DATABASE_URL（d1 仅存在于 Cloudflare 运行时，容器内不可用）"
  exit 1
fi

# 未显式设置 DB_TYPE 时按 DATABASE_URL 协议推断（与 prepare-db.mjs 逻辑一致）
if [ -z "$DB_TYPE" ]; then
  if echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'; then
    export DB_TYPE=pg
  elif echo "$DATABASE_URL" | grep -qE '^mariadb://'; then
    export DB_TYPE=mariadb
  elif echo "$DATABASE_URL" | grep -qE '^mysql://' || echo "$DATABASE_URL" | grep -qE '^mysqls://'; then
    export DB_TYPE=tidb
  else
    echo "[启动] 错误：无法从 DATABASE_URL 推断 DB_TYPE，请显式设置 DB_TYPE（tidb / mariadb / pg）"
    exit 1
  fi
  echo "[启动] 未设置 DB_TYPE，已按 DATABASE_URL 推断为 $DB_TYPE"
fi

if [ "$DB_TYPE" = "d1" ]; then
  echo "[启动] 错误：D1 仅存在于 Cloudflare 运行时，Docker 部署请使用 DB_TYPE=tidb / mariadb / pg"
  exit 1
fi

# ==================== 同步表结构 ====================
# prepare-db.mjs 在 DB_PUSH=1 时按 DB_TYPE 重新生成 Prisma Client 并执行
# prisma db push（push 前自动执行平台密钥迁移，防止 api_key 列被删时数据丢失）。
# 幂等操作：表结构无变化时秒级完成。
echo "[启动] 同步数据库表结构（DB_TYPE=$DB_TYPE）..."
DB_PUSH=1 node scripts/prepare-db.mjs

echo "[启动] 启动应用..."
# 限制 V8 堆上限为 192MB，在 256MB 容器中预留 ~64MB 给 V8 外部内存（pg 连接 buffer、libuv 线程池等），
# 迫使 GC 在接近上限时积极回收，防止 RSS 无限增长触发 OOM killer
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=192"
exec node server.js
