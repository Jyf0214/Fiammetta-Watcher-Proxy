---
name: nextjs-manual-scaffold
description: 手动搭建 Next.js 16 项目结构，当 create-next-app 进入交互模式或网络失败时的替代方案
source: auto-skill
extracted_at: '2026-06-20T23:26:01.872Z'
---

# 手动搭建 Next.js 16 项目

## 触发条件

- `npx create-next-app@latest` 进入交互模式无法自动完成
- 网络问题导致 create-next-app 超时
- 需要在已有仓库中初始化 Next.js（不希望覆盖现有文件）

## 操作步骤

### 1. 创建目录结构

```bash
mkdir -p src/app src/components src/lib src/services src/types src/i18n prisma messages public
```

### 2. 手动创建配置文件

**package.json** — 关键字段：
- `next: "^16.2.9"` (或目标版本)
- `react` / `react-dom` 需与 Next.js 版本匹配
- `scripts.build` 必须包含 `prisma generate`（如果使用 Prisma）
- `scripts.postinstall` 设为 `prisma generate` 确保 npm install 后自动生成客户端

**tsconfig.json** — 必须包含：
```json
{
  "compilerOptions": {
    "jsx": "preserve",
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  }
}
```

**next.config.ts** — standalone 模式部署：
```ts
const nextConfig: NextConfig = {
  output: "standalone",
};
```

**postcss.config.mjs** — TailwindCSS 4 使用新插件名：
```js
const config = {
  plugins: { "@tailwindcss/postcss": {} },
};
```

### 3. 创建基础应用文件

- `src/app/globals.css` — `@import "tailwindcss";`
- `src/app/layout.tsx` — 根布局
- `src/app/page.tsx` — 首页

### 4. 安装依赖

```bash
npm install
```

如果使用 Prisma，必须先创建 `prisma/schema.prisma` 再运行 npm install（否则 postinstall 的 prisma generate 会失败）。

### 5. 验证

```bash
npx tsc --noEmit     # TypeScript 检查
npm run build        # 构建验证
```

## 常见陷阱

- **Prisma schema 必须先于 npm install 创建**：postinstall 脚本会执行 `prisma generate`，找不到 schema 会报错
- **TailwindCSS 4 的 PostCSS 插件名变了**：从 `tailwindcss` 变为 `@tailwindcss/postcss`
- **tsconfig 的 jsx 必须是 `preserve`**：Next.js 构建时会自动改为 `react-jsx`

## Docker 多阶段构建（standalone 模式）

### Dockerfile 完整模式

```dockerfile
# ==================== 构建阶段 ====================
FROM node:22-alpine AS builder
WORKDIR /app

# npm ci 必须 --ignore-scripts，否则 postinstall 的 prisma generate 会失败
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# 复制 schema 后单独 generate
COPY prisma ./prisma/
RUN npx prisma generate

COPY . .
RUN npm run build

# ==================== 运行阶段 ====================
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
RUN apk add --no-cache wget

# standalone 模式：public 从构建上下文复制（不是从 builder）
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# 启动脚本（含 prisma db push）
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/ || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
```

### docker-entrypoint.sh（启动时初始化数据库）

```sh
#!/bin/sh
set -e
echo "[启动] 运行数据库迁移..."
npx prisma db push
echo "[启动] 数据库迁移完成"
echo "[启动] 启动应用..."
exec node server.js
```

**关键注意事项**：

1. **不要使用 `--skip-generate`**：`prisma db push` 不支持此参数，会报 `unknown or unexpected option: --skip-generate`
2. **Dockerfile 必须复制 `package.json`**：否则 `npx prisma` 会下载最新版本（如 7.8.0），而不是使用项目中安装的版本（如 6.19.3）
3. **Dockerfile 必须复制 `node_modules/prisma`**：确保本地 prisma CLI 可用

```dockerfile
# runner 阶段必须包含这些 COPY
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
```

### docker-compose.yml PORT 联动

```yaml
services:
  app:
    ports:
      - "${PORT:-3000}:${PORT:-3000}"  # 宿主端口:容器端口联动
    environment:
      - PORT=${PORT:-3000}  # 传递给应用
      - DATABASE_URL=${DATABASE_URL:-postgresql://postgres:postgres@db:5432/mydb}
      - JWT_SECRET=${JWT_SECRET:-change-me}
```

### public 目录必须存在

空的 `public/` 目录不会被 git 跟踪，需要添加 `.gitkeep`：

```bash
touch public/.gitkeep
```

否则 Docker `COPY public ./public` 会因目录不存在而失败。

## ESLint 9 配置（Next.js 16 + TypeScript）

```js
// eslint.config.mjs
import tseslint from "typescript-eslint";
import js from "@eslint/js";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  { ignores: ["node_modules/", ".next/", "out/"] },
];
```

安装依赖：`npm install -D typescript-eslint @eslint/js`

## Git Hooks

### pre-commit（TypeScript + ESLint）

```sh
#!/bin/sh
echo "🔍 [pre-commit] 开始代码质量检查..."
npx tsc --noEmit || { echo "❌ TypeScript 检查失败"; exit 1; }
npx eslint src/ || { echo "❌ ESLint 检查失败"; exit 1; }
echo "✅ [pre-commit] 所有检查通过"
```

### pre-push（Prisma generate + 构建）

```sh
#!/bin/sh
echo "🚀 [pre-push] 开始构建验证..."
npx prisma generate || { echo "❌ Prisma generate 失败"; exit 1; }
npm run build || { echo "❌ 构建失败"; exit 1; }
echo "✅ [pre-push] 所有验证通过"
```

```bash
chmod +x .git/hooks/pre-commit .git/hooks/pre-push
```

## GitHub Actions CI/CD

### Docker 工作流

```yaml
name: Docker Build & Push
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:  # 支持手动触发

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        if: github.event_name != 'pull_request'
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha
            type=raw,value=latest,enable={{is_default_branch}}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: ${{ github.event_name != 'pull_request' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
          platforms: linux/amd64  # 单平台构建更快
```

### 使用 gh CLI 手动触发

```bash
gh workflow run docker.yml --ref main
gh run list --workflow=docker.yml --limit=1
gh run view <run-id> --json status,conclusion
```

**注意**：`gh run watch` 会进入交互模式，用 `gh run view --json` 非交互查询。

### CI 工作流

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  lint-and-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx eslint src/
      - run: npm run build
```

## 关键踩坑：prisma 必须在 dependencies 中

**这是最常犯的错误**：`prisma` 如果放在 `devDependencies`，Docker runner 阶段执行 `npm ci --omit=dev` 时不会安装 prisma CLI，导致容器启动时 `sh: prisma: not found`。

```json
// ❌ 错误：prisma 在 devDependencies
{
  "dependencies": { "@prisma/client": "^6.19.3" },
  "devDependencies": { "prisma": "^6.19.3" }
}

// ✅ 正确：prisma 在 dependencies
{
  "dependencies": {
    "@prisma/client": "^6.19.3",
    "prisma": "^6.19.3"
  }
}
```

**原因链**：
1. Dockerfile runner 阶段：`npm ci --omit=dev` 只安装 `dependencies`
2. `prisma` 不在其中 → `node_modules/prisma/` 不存在
3. entrypoint 执行 `npx prisma db push` → 找不到 prisma CLI
4. 即使用 `node ./node_modules/prisma/build/index.js` 也找不到（目录不存在）

## Hugging Face Spaces Docker 配置

HF Spaces 使用 Docker 时，README.md 必须包含 YAML frontmatter：

```yaml
---
title: App Name
emoji: 🐠
colorFrom: blue
colorTo: green
sdk: docker
pinned: false
---

# App Description
```

**没有 `sdk: docker`** → HF 不会使用 Dockerfile 构建，导致部署失败。

## Git 历史重写（修复 author/committer 身份）

当全局 git config 设置了错误的 user.name/email 时，即使用 `--author` 提交，committer 身份仍来自全局配置。修复方法：

```bash
# 重写所有提交的 author 和 committer
git filter-branch -f --env-filter '
export GIT_AUTHOR_NAME="Jyf0214"
export GIT_AUTHOR_EMAIL="169313142+Jyf0214@users.noreply.github.com"
export GIT_COMMITTER_NAME="Jyf0214"
export GIT_COMMITTER_EMAIL="169313142+Jyf0214@users.noreply.github.com"
' -- --all

# 强制推送覆盖远程历史
git push --force origin main
```

**验证**：
```bash
git log --format="%h %an <%ae> | %cn <%ce> %s" -5
# 应显示 author 和 committer 都是 Jyf0214
```

## gh CLI 非交互式操作

`gh run watch` 会进入交互模式，用以下替代：

```bash
# 查看工作流状态（非交互）
gh run list --workflow=docker.yml --limit=1 --json databaseId,status,conclusion

# 查看特定运行详情
gh run view <run-id> --json status,conclusion

# 触发工作流
gh workflow run docker.yml --ref main
```

## Docker runner 阶段完整 COPY 清单

```dockerfile
# runner 阶段必须包含的 COPY
COPY --from=builder /app/.next/standalone ./       # Next.js standalone 输出
COPY --from=builder /app/.next/static ./.next/static # 静态资源
COPY --from=builder /app/package.json ./package.json  # npx 需要
COPY public ./public                                   # 从构建上下文（非 builder）
COPY --from=builder /app/prisma ./prisma             # Prisma schema
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma  # Prisma Client 运行时
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma  # Prisma 引擎
```
