#!/bin/bash
# ================================================================
# lite 构建门控脚本
#
# 精简版（Dockerfile.lite）构建时，临时移走 pages/ 下除 api/v1 与
# api/cron 外的所有路由（前端页面 + 管理 API 等），使 next build
# 只构建 V1 代理与定时器接口；构建完成后由 lite-gate-restore.sh
# 原样还原。路由代码零改动、零新建，直接复用 pages/api/v1 与
# pages/api/cron 本体。
#
# 使用方式：
#   bash scripts/lite-gate.sh               # 裁剪路由（lite 构建）
#   bash scripts/lite-gate-restore.sh       # 还原路由
# ================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

GATE_TMP=".lite-gate-tmp"

# 上次构建若中断（如 Turbopack 报错）pages 可能还处于裁剪状态，
# 先还原再裁剪，防止 tar 备份残留导致路由丢失。
if [ -f "$GATE_TMP/pages.tar" ]; then
  echo "还原上次中断构建的 pages 目录..."
  rm -rf pages
  tar -xf "$GATE_TMP/pages.tar" -C "$PROJECT_ROOT"
  rm -rf "$GATE_TMP"
fi

echo "lite 模式：临时移走除 pages/api/v1 与 pages/api/cron 外的所有路由"

mkdir -p "$GATE_TMP"

# 1. 备份完整 pages 目录
tar -cf "$GATE_TMP/pages.tar" pages

# 2. 保留 v1 / cron 路由
mv pages/api/v1 "$GATE_TMP/v1"
mv pages/api/cron "$GATE_TMP/cron"

# 3. 重建仅含 v1 / cron 的 pages 目录
rm -rf pages
mkdir -p pages/api
mv "$GATE_TMP/v1" pages/api/v1
mv "$GATE_TMP/cron" pages/api/cron

echo "  ✓ 保留: pages/api/v1/ pages/api/cron/"
echo "  ✓ 其余路由已临时移走（构建完成后由 lite-gate-restore.sh 还原）"
