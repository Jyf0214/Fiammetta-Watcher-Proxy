#!/usr/bin/env bash
# EdgeOne Makers 部署脚本
#
# 日志脱敏：
#   - token 通过 env 注入（不在命令行出现）
#   - 部署输出流经 grep 过滤含 token/https:// 的行，防止 Token 与数据库连接串
#     进入 GitHub Actions 日志
#   - PIPESTATUS 保留 edgeone 真实退出码，部署失败仍会导致 job 失败

set -euo pipefail

echo "pin 版本防止 CLI 行为漂移"
npm install -g edgeone@1.6.19

set +e
edgeone makers deploy \
  -n "$EO_PROJECT_NAME" \
  -t "$EO_API_TOKEN" \
  -e production 2>&1 | grep -viE --line-buffered "token|https://"
status=${PIPESTATUS[0]}
exit "$status"
