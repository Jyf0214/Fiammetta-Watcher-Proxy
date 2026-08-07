#!/bin/bash
# ================================================================
# lite 构建还原脚本
#
# lite 构建（bash scripts/lite-gate.sh && next build）完成后，
# 将临时移走的路由原样还原到 pages/。
#
# 使用方式：
#   bash scripts/lite-gate-restore.sh
# ================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

GATE_TMP=".lite-gate-tmp"

if [ -f "$GATE_TMP/pages.tar" ]; then
  echo "还原 pages 目录..."
  rm -rf pages
  tar -xf "$GATE_TMP/pages.tar" -C "$PROJECT_ROOT"
  rm -rf "$GATE_TMP"
  echo "✓ 还原完成"
else
  echo "无需还原"
fi
