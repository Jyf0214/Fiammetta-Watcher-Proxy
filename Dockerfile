# ==================== 构建阶段 ====================
FROM node:22-alpine AS builder

WORKDIR /app

# 创建非 root 用户（构建阶段也以此用户运行，避免最终 chown）
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    chown -R nextjs:nodejs /app

# 构建方言：all=生成全部四种方言 client（d1/mysql/mariadb/pg），镜像与任意运行时
# DB_TYPE 通用（Docker 无 Worker 体积限制）；指定单一方言可缩小镜像体积，
# 但指定单一方言时构建期与运行期 DB_TYPE 必须一致，否则运行时会以错误的
# 方言 client 加载对应 adapter（provider/adapter 不匹配报错）。
ARG DB_TYPE=all
ENV DB_TYPE=$DB_TYPE

# 部署平台：构建期内联 NEXT_PUBLIC_DEPLOY_PLATFORM（前端展示/门控用），
# 必须与运行阶段一致，否则管理页会显示“当前部署平台：—”
ENV DEPLOY_PLATFORM=docker

# 安装依赖（--ignore-scripts 跳过 prepare 钩子，Prisma Client 由 prebuild 钩子生成）
# --legacy-peer-deps：项目必须 legacy 模式（React 19 与 vitepress 链 @docsearch/react 的 peer <19 冲突）。
# 容器内无 .npmrc（本文件未复制它），strict 模式下 npm ci 的 lockfile 校验会报 EUSAGE
# （Missing: search-insights / Invalid: @cloudflare/workers-types），必须显式传 flag。
COPY --chown=nextjs:nodejs package.json package-lock.json ./
USER nextjs
RUN npm ci --ignore-scripts --legacy-peer-deps

# 复制源码并构建（prebuild 钩子自动生成对应方言的 Prisma Client；
# 构建环境无 CI=true，prepare-db.mjs 不会执行 db push，表结构由容器启动时同步）
COPY --chown=nextjs:nodejs . .

RUN npm run build

# ==================== 运行阶段 ====================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV ENVIRONMENT=production
# 部署平台：Docker 直连部署默认值（compose 或 docker run -e 可覆盖），
# 登录限流等 IP 解析只信任 TCP 对端，忽略所有前置头
ENV DEPLOY_PLATFORM=docker
ENV NEXT_TELEMETRY_DISABLED=1

# wget 用于健康检查
RUN apk add --no-cache wget

# 创建非 root 用户（与 builder 阶段相同 UID/GID）
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    chown -R nextjs:nodejs /app

# 安装生产依赖（含 prisma CLI，用于启动时同步表结构）
# --legacy-peer-deps：同 builder 阶段，容器内无 .npmrc，strict 模式会 EUSAGE
COPY --chown=nextjs:nodejs --from=builder /app/package.json /app/package-lock.json ./
USER nextjs
RUN npm ci --omit=dev --ignore-scripts --legacy-peer-deps

# 复制构建产物与运行所需文件（带所有权，避免最终 chown）
# standalone 精简产物（server.js + nft 追踪的精简 node_modules + 内联 bundle）：
# 运行时只加载构建期追踪到的模块，避免全量 node_modules 进内存（内存 ~180MB → ~120MB）
COPY --chown=nextjs:nodejs --from=builder /app/.next/standalone ./
COPY --chown=nextjs:nodejs --from=builder /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs --from=builder /app/public ./public
COPY --chown=nextjs:nodejs --from=builder /app/prisma ./prisma
COPY --chown=nextjs:nodejs --from=builder /app/prisma.config.ts ./
COPY --chown=nextjs:nodejs --from=builder /app/scripts ./scripts/

# 启动脚本（启动时同步表结构）
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

USER nextjs

ENV PORT=3000
# standalone server.js 按 HOSTNAME 决定监听地址，必须监听 0.0.0.0 供容器外访问
ENV HOSTNAME="0.0.0.0"

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/ || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
