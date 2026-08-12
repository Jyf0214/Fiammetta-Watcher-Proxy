#!/bin/bash
# ================================================================
# Worker lite 构建门控脚本（仅 CF 部署，CI 内使用）
#
# 环境变量 VERSION（GitHub 仓库变量，可选值 latest / lite）：
#   - latest（默认）：部署全量 Worker（评分/重试/熔断/全部 Cron）
#   - lite：部署精简 Worker 版本——仅负载均衡（无评分/优先级/自动重试/
#     熔断器，只写请求日志），Cron 仅保留模型发现（拉取平台信息），
#     以最大化减少 CPU 运行时间
#
# 仅在 CI（ephemeral checkout）中执行，构建后无需还原；
# 本地开发/测试不使用本脚本（worker 测试走 vitest，不依赖 wrangler.toml）。
#
# 使用方式：
#   VERSION=lite bash scripts/worker-lite-gate.sh   # 切换为 lite 入口
#   bash scripts/worker-lite-gate.sh                # latest（no-op）
# ================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

if [ "${VERSION:-latest}" != "lite" ]; then
  echo "VERSION=${VERSION:-latest}：保持全量 Worker 配置"
  exit 0
fi

echo "lite 模式：切换 Worker 入口为 index-lite.ts，Cron 仅保留模型发现（每 6 小时）"

WORKER_DIR="$PROJECT_ROOT/worker"

# 1. 主入口：index.ts → index-lite.ts
sed -i 's|^main = "src/index.ts"|main = "src/index-lite.ts"|' "$WORKER_DIR/wrangler.toml"

# 2. Cron：仅保留模型发现（评分/Key 重置/日志归档全部移除）
sed -i 's|^crons = .*|crons = ["0 */6 * * *"]|' "$WORKER_DIR/wrangler.toml"

# 3. 输出生效配置，便于 CI 日志核对
grep -E '^(main|crons)' "$WORKER_DIR/wrangler.toml"
echo "  ✓ Worker 已切换为 lite 配置"
