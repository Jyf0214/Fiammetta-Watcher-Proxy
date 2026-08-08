# ==================== 构建阶段 ====================
FROM node:22-alpine AS builder

WORKDIR /app

# 构建方言：Docker 部署仅支持 tidb / mariadb / pg（d1 只存在于 Cloudflare 运行时）。
# 必须与运行时 DB_TYPE 一致——决定构建期生成的 Prisma Client 方言与转译内联的数据库栈。
ARG DB_TYPE=pg
ENV DB_TYPE=$DB_TYPE

# 安装依赖（--ignore-scripts 跳过 prepare 钩子，Prisma Client 由 prebuild 钩子生成）
# --legacy-peer-deps：项目必须 legacy 模式（React 19 与 vitepress 链 @docsearch/react 的 peer <19 冲突）。
# 容器内无 .npmrc（本文件未复制它），strict 模式下 npm ci 的 lockfile 校验会报 EUSAGE
# （Missing: search-insights / Invalid: @cloudflare/workers-types），必须显式传 flag。
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --legacy-peer-deps

# 复制源码并构建（prebuild 钩子自动生成对应方言的 Prisma Client；
# 构建环境无 CI=true，prepare-db.mjs 不会执行 db push，表结构由容器启动时同步）
COPY . .

RUN npm run build

# ==================== 运行阶段 ====================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV ENVIRONMENT=production
ENV NEXT_TELEMETRY_DISABLED=1

# wget 用于健康检查
RUN apk add --no-cache wget

# 安装生产依赖（含 prisma CLI，用于启动时同步表结构）
# --legacy-peer-deps：同 builder 阶段，容器内无 .npmrc，strict 模式会 EUSAGE
COPY --from=builder /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps

# 复制构建产物与运行所需文件
# standalone 精简产物（server.js + nft 追踪的精简 node_modules + 内联 bundle）：
# 运行时只加载构建期追踪到的模块，避免全量 node_modules 进内存（内存 ~180MB → ~120MB）
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/scripts ./scripts/

# 启动脚本（启动时同步表结构）
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# 创建非 root 用户运行应用
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# 确保应用目录对 nextjs 用户可写（启动脚本会重新生成 Prisma Client 到 src/generated）
RUN chown -R nextjs:nodejs /app

EXPOSE 3000

USER nextjs

ENV PORT=3000
# standalone server.js 按 HOSTNAME 决定监听地址，必须监听 0.0.0.0 供容器外访问
ENV HOSTNAME="0.0.0.0"

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/ || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
