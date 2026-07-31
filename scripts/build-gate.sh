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

# 清理上次中断构建可能遗留的临时目录，防止二次构建时路由嵌套（.build-gate-tmp/v1/v1）
rm -rf "$GATE_TMP"

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
