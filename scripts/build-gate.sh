#!/bin/bash
# ================================================================
# 构建门控脚本
#
# DEPLOY_PLATFORM=cf 时（Cloudflare 部署）将 Pages API v1 和 cron
# 路由移到临时目录，构建完成后由 build-gate-restore.sh 还原。
#
# 其他平台（vercel / edgeone / 本地开发）不设 DEPLOY_PLATFORM，
# 保留 v1 和 cron 路由（由 Pages API / Next.js Server 处理）。
#
# 使用方式：
#   DEPLOY_PLATFORM=cf bash scripts/build-gate.sh   # 删除路由（CF 部署）
#   DEPLOY_PLATFORM=cf bash scripts/build-gate-restore.sh  # 还原路由
# ================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

GATE_TMP=".build-gate-tmp"

# 上次构建若中断（如 Turbopack 报错）路由可能还留在临时目录，先还原再清理，
# 防止 rm -rf 把 v1/cron 路由直接删掉（线上事故级隐患）。
# 注意：mv 走目录后原目录仍在，必须按"临时目录非空 + 目标目录为空"判断，不能只看目录存在性。
if [ -d "$GATE_TMP" ]; then
  for route in v1 cron; do
    if [ -d "$GATE_TMP/$route" ] && [ -n "$(ls -A "$GATE_TMP/$route" 2>/dev/null)" ] && [ -z "$(ls -A "pages/api/$route" 2>/dev/null)" ]; then
      rmdir "pages/api/$route" 2>/dev/null || true
      mv "$GATE_TMP/$route" "pages/api/$route"
      echo "  ♻️  还原上次中断构建遗留的路由: pages/api/$route/"
    fi
  done
  rm -rf "$GATE_TMP"
fi

if [ "${DEPLOY_PLATFORM:-}" = "cf" ]; then
  echo "🏗️  CF 模式：临时移除 Pages API v1 和 cron 路由"

  mkdir -p "$GATE_TMP"

  if [ -d "pages/api/v1" ]; then
    mv pages/api/v1 "$GATE_TMP/v1"
    echo "  ✅ pages/api/v1/ → $GATE_TMP/v1"
  fi

  if [ -d "pages/api/cron" ]; then
    mv pages/api/cron "$GATE_TMP/cron"
    echo "  ✅ pages/api/cron/ → $GATE_TMP/cron"
  fi
else
  echo "🌐 非 CF 模式：保留 Pages API v1 和 cron 路由"
fi
