---
name: hf-space-sync
description: GitHub Actions 自动同步代码到 Hugging Face Space 的纯 git 工作流模式
source: auto-skill
extracted_at: '2026-06-21T02:40:45.185Z'
---

# HF Space 自动同步工作流

通过 GitHub Actions 在 push 到 main 时自动同步代码到 Hugging Face Space，纯 git 方式，不安装 HF CLI。

## 核心约束

1. **纯 git 实现**：只使用 `git remote add`、`git fetch`、`git push`，不安装 `huggingface-cli`
2. **secrets 驱动**：仓库地址和认证都使用 `secrets`（不用 `vars`）
3. **env 字段映射**：每个使用 secrets 的步骤必须通过 `env` 字段将 secret 映射为环境变量
4. **优雅降级**：未配置密钥时静默跳过，不报错
5. **差异检测**：比较 commit hash，相同则跳过，不同则 force push

## 工作流结构

```yaml
name: HF Space 同步

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest

    steps:
      - name: 检查配置
        id: check
        env:
          HF_REPO: ${{ secrets.HF_REPO }}
          HF_TOKEN: ${{ secrets.HF_TOKEN }}
        run: |
          if [ -z "$HF_REPO" ]; then
            echo "❌ 未配置 HF_REPO 密钥，跳过同步"
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          if [ -z "$HF_TOKEN" ]; then
            echo "❌ 未配置 HF_TOKEN 密钥，跳过同步"
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          echo "✅ HF 配置检查通过"
          echo "skip=false" >> "$GITHUB_OUTPUT"
          echo "repo=$HF_REPO" >> "$GITHUB_OUTPUT"

      - name: 检出代码
        if: steps.check.outputs.skip != 'true'
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: 添加 HF 远程仓库
        if: steps.check.outputs.skip != 'true'
        env:
          HF_REPO: ${{ secrets.HF_REPO }}
          HF_TOKEN: ${{ secrets.HF_TOKEN }}
        run: |
          git remote add hf "https://oauth2:$HF_TOKEN@huggingface.co/spaces/$HF_REPO.git"
          git fetch hf main --depth=1

      - name: 检查差异
        if: steps.check.outputs.skip != 'true'
        id: diff
        run: |
          LOCAL=$(git rev-parse HEAD)
          HF=$(git rev-parse hf/main 2>/dev/null || echo "none")
          if [ "$LOCAL" = "$HF" ]; then
            echo "synced=true" >> "$GITHUB_OUTPUT"
          else
            echo "synced=false" >> "$GITHUB_OUTPUT"
          fi

      - name: 同步到 HF Space
        if: steps.check.outputs.skip != 'true' && steps.diff.outputs.synced == 'false'
        env:
          HF_REPO: ${{ secrets.HF_REPO }}
        run: |
          echo "🚀 正在推送至 HF Space ($HF_REPO)..."
          git push hf main:main --force
          echo "✅ 同步完成"

      - name: 同步结果
        if: steps.check.outputs.skip != 'true'
        env:
          HF_REPO: ${{ secrets.HF_REPO }}
        run: |
          echo "HF Space ($HF_REPO) 同步状态:"
          if [ "${{ steps.diff.outputs.synced }}" = "true" ]; then
            echo "✅ 已同步"
          else
            echo "🔄 已推送更新"
          fi
```

## 关键实现细节

### 1. 不能在 job 级别 if 中使用 secrets

GitHub Actions 限制：`secrets` 不能在 job 级别的 `if` 条件中引用。必须在 step 级别检查。

**错误写法：**
```yaml
jobs:
  sync:
    if: ${{ secrets.HF_REPO != '' && secrets.HF_TOKEN != '' }}  # ❌ secrets 不可用
```

**正确写法：**
```yaml
jobs:
  sync:
    steps:
      - name: 检查配置
        env:
          HF_REPO: ${{ secrets.HF_REPO }}
        run: |
          if [ -z "$HF_REPO" ]; then
            echo "skip=true" >> "$GITHUB_OUTPUT"
          fi
      - name: 后续步骤
        if: steps.check.outputs.skip != 'true'  # ✅ step 级别检查
```

### 2. 必须使用 env 字段映射 secrets

GitHub Actions 安全规范要求：secrets 不能直接在 `run` 块中使用 `${{ secrets.XXX }}` 语法，必须通过 `env` 字段映射为环境变量。

**错误写法：**
```yaml
- name: 使用 secret
  run: |
    echo "${{ secrets.HF_TOKEN }}"  # ❌ 直接引用 secrets
```

**正确写法：**
```yaml
- name: 使用 secret
  env:
    HF_TOKEN: ${{ secrets.HF_TOKEN }}
  run: |
    echo "$HF_TOKEN"  # ✅ 通过环境变量引用
```

### 3. HF Space git 远程仓库格式

```
https://oauth2:{HF_TOKEN}@huggingface.co/spaces/{用户名}/{空间名}.git
```

### 4. 差异检测方式

比较 `HEAD` 与 `hf/main` 的 commit hash：
- 相同 → 跳过同步
- 不同 → force push

### 5. 密钥配置

在 GitHub 仓库 Settings → Secrets and variables → Actions → Secrets 中配置：

| 名称 | 格式示例 |
|------|----------|
| `HF_REPO` | `username/space-name` |
| `HF_TOKEN` | HF Access Token（需 write 权限） |

## 适用场景

- Next.js / Vite / 任意前端项目部署到 HF Space
- 需要在 push 到 main 时自动同步
- 不想安装 HF CLI，纯 git 操作

## 注意事项

- HF Space 支持自动构建，push 后会触发 Space 重新部署
- 使用 `--force` 推送是因为 HF Space 可能有独立的提交历史
- 如果 HF_TOKEN 过期或权限不足，fetch/push 会失败，工作流会报错
- HF Space 需要在 Space Settings → Secrets 中配置 `DATABASE_URL`、`JWT_SECRET`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`
