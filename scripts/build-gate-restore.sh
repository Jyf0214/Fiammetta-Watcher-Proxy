#!/bin/bash
# ================================================================
# 构建还原脚本
#
# DEPLOY_PLATFORM=cf 的 CF 构建完成后，将 build-gate.sh 移走的
# 路由还原回来。
#
# 使用方式：
#   DEPLOY_PLATFORM=cf bash scripts/build-gate-restore.sh
# ================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

GATE_TMP=".build-gate-tmp"

if [ "${DEPLOY_PLATFORM:-}" = "cf" ] && [ -d "$GATE_TMP" ]; then
  echo "🔄 还原被临时移除的 Pages API 路由..."

  if [ -d "$GATE_TMP/v1" ]; then
    mv "$GATE_TMP/v1" pages/api/v1
    echo "  ✅ $GATE_TMP/v1 → pages/api/v1/"
  fi

  if [ -d "$GATE_TMP/cron" ]; then
    mv "$GATE_TMP/cron" pages/api/cron
    echo "  ✅ $GATE_TMP/cron → pages/api/cron/"
  fi

  rmdir "$GATE_TMP" 2>/dev/null || true
  echo "✅ 还原完成"
else
  echo "🌐 无需还原"
fi
