#!/bin/bash
# ================================================================
# 构建门控脚本
#
# CF 构建时将 Pages API v1 和 cron 路由移到临时目录，
# 构建完成后由 build-gate-restore.sh 还原。
#
# 非 CF 构建时不做任何操作。
#
# 使用方式：
#   CF_DEPLOY=true bash scripts/build-gate.sh   # 删除路由
#   CF_DEPLOY=true bash scripts/build-gate-restore.sh  # 还原路由
# ================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

GATE_TMP=".build-gate-tmp"

if [ "${CF_DEPLOY:-}" = "true" ]; then
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
