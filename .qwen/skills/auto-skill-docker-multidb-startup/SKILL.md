---
name: docker-multidb-startup
description: Docker 容器启动时根据 DATABASE_URL 自动选择 Prisma schema（MySQL/PostgreSQL 双数据库支持）
source: auto-skill
extracted_at: '2026-06-21T00:30:00.000Z'
---

# Docker 多数据库启动模式

## 问题背景

Prisma 的 `datasource provider` 字段不支持 `env()` 动态切换。当项目需要同时支持 MySQL 和 PostgreSQL 时，需要在 Docker 启动时根据 `DATABASE_URL` 协议自动选择对应的 schema 文件。

## 目录结构

```
prisma/
├── schema.prisma          # 默认 PostgreSQL 版本
└── mysql/
    └── schema.prisma      # MySQL 版本（provider = "mysql"）
```

## entrypoint.sh 自动选择 schema

```sh
#!/bin/sh
set -e

echo "[启动] 运行数据库迁移..."

# 根据 DATABASE_URL 协议自动选择 Prisma schema
if echo "$DATABASE_URL" | grep -qE '^mysql://'; then
  echo "[启动] 检测到 MySQL 数据库，使用 MySQL schema"
  cp prisma/mysql/schema.prisma prisma/schema.prisma
elif echo "$DATABASE_URL" | grep -qE '^postgres(ql)?://'; then
  echo "[启动] 检测到 PostgreSQL 数据库，使用 PostgreSQL schema"
  # 保持默认 schema 不变
else
  echo "[启动] 警告：DATABASE_URL 协议无法识别，默认使用 PostgreSQL"
fi

node ./node_modules/prisma/build/index.js db push
echo "[启动] 数据库迁移完成"

echo "[启动] 启动应用..."
exec node server.js
```

## 关键要点

### 1. 使用 `node ./node_modules/prisma/build/index.js` 而非 `npx prisma`

```sh
# ❌ npx 可能下载错误版本
npx prisma db push

# ✅ 直接调用本地 prisma CLI
node ./node_modules/prisma/build/index.js db push
```

**原因**：`npx` 在 `node_modules/.bin/prisma` 不存在时会从 npm registry 下载最新版本，可能与项目版本不兼容。

### 2. `prisma` 必须在 `dependencies`（非 `devDependencies`）

```json
// ❌ Docker npm ci --omit=dev 不会安装
{ "devDependencies": { "prisma": "^6.19.3" } }

// ✅ 必须在 dependencies
{ "dependencies": { "prisma": "^6.19.3", "@prisma/client": "^6.19.3" } }
```

### 3. Dockerfile runner 阶段 COPY 清单

```dockerfile
# runner 阶段必须包含
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
```

### 4. MySQL schema 生成方式

```bash
# 从 PostgreSQL schema 生成 MySQL 版本
sed 's/provider = "postgresql"/provider = "mysql"/' prisma/schema.prisma > prisma/mysql/schema.prisma
```

注意：MySQL 和 PostgreSQL 的 Prisma schema 在某些类型上有差异（如 `Json` vs `JSON`），需要手动检查。

### 5. `prisma db push` 不支持 `--skip-generate`

```sh
# ❌ 报错：unknown or unexpected option: --skip-generate
node ./node_modules/prisma/build/index.js db push --skip-generate

# ✅ 直接执行
node ./node_modules/prisma/build/index.js db push
```

## 完整 Dockerfile 模式

```dockerfile
# ==================== 构建阶段 ====================
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY prisma ./prisma/
RUN npx prisma generate
COPY . .
RUN npm run build

# ==================== 运行阶段 ====================
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache wget

# 安装生产依赖（含 prisma CLI）
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# 复制构建产物
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/ || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
```

## 调试技巧

```bash
# 进入容器检查 prisma 是否可用
docker exec -it <container> sh
node ./node_modules/prisma/build/index.js --version

# 检查 DATABASE_URL 是否正确传递
docker exec -it <container> sh -c 'echo $DATABASE_URL'

# 手动执行 db push
docker exec -it <container> node ./node_modules/prisma/build/index.js db push
```
