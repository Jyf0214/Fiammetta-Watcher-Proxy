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
  elif echo "$DATABASE_URL" | grep -qE '^mysqls://'; then
    export DB_TYPE=tidb
  elif echo "$DATABASE_URL" | grep -qE '^mysql://'; then
    export DB_TYPE=mysql
  else
    echo "[启动] 错误：无法从 DATABASE_URL 推断 DB_TYPE，请显式设置 DB_TYPE（tidb / mysql / mariadb / pg）"
    exit 1
  fi
  echo "[启动] 未设置 DB_TYPE，已按 DATABASE_URL 推断为 $DB_TYPE"
fi

if [ "$DB_TYPE" = "d1" ]; then
  echo "[启动] 错误：D1 仅存在于 Cloudflare 运行时，Docker 部署请使用 DB_TYPE=tidb / mysql / mariadb / pg"
  exit 1
fi

# ==================== 同步表结构 ====================
# prepare-db.mjs 在 DB_PUSH=1 时按 DB_TYPE 重新生成 Prisma Client 并执行
# prisma db push（push 前自动执行平台密钥迁移，防止 api_key 列被删时数据丢失）。
# 幂等操作：表结构无变化时秒级完成。
echo "[启动] 同步数据库表结构（DB_TYPE=$DB_TYPE）..."
DB_PUSH=1 node scripts/prepare-db.mjs

# ==================== 启动独立定时器进程 ====================
# 定时器为容器内独立 Node 进程（.build/scheduler.cjs，由 build-scheduler.mjs
# 打包，内联 Prisma client 与 wasm 编译器），与主应用进程分离：
# 不依赖 Next.js instrumentation（instrumentation 会把调度器链编入 Cloudflare
# Edge Worker 导致 Pages Function 体积超限）。DB_TYPE/DATABASE_URL 已在上方
# 推断导出，定时器进程继承后直连数据库。
echo "[启动] 启动内部定时器进程..."
# 限制 V8 堆上限为 192MB，在 256MB 容器中预留 ~64MB 给 V8 外部内存（pg 连接
# buffer、libuv 线程池等），迫使 GC 在接近上限时积极回收，防止 RSS 无限增长
# 触发 OOM killer（定时器进程与主进程同受此限制）
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=192"
# 产物缺失/损坏时阻止容器启动，避免定时任务（key-reset/log-archive/model-fetch）静默停摆
node --check .build/scheduler.cjs || { echo "[启动] 错误：定时器进程产物缺失或损坏（.build/scheduler.cjs）"; exit 1; }
node .build/scheduler.cjs &

# ==================== 启动期设备注册 ====================
# Docker 容器启动时按 NODE_NAME 注册/复用设备 UUID（管理后台"设备管理"页可见）。
# 仅 Docker 部署生效：EdgeOne/Vercel/本地/CF 都不调（CF 部署无 .build/register-device.cjs）。
# 同步执行（前台）而非 waitUntil：注册失败需在启动期可见，且仅一次轻量读写（毫秒级）。
echo "[启动] 注册设备（按 NODE_NAME）..."
node --check .build/register-device.cjs || { echo "[启动] 错误：设备注册进程产物缺失或损坏（.build/register-device.cjs）"; exit 1; }
node .build/register-device.cjs

echo "[启动] 启动应用..."
exec node server.js
