# ==================== 构建阶段 ====================
FROM node:22-alpine AS builder

WORKDIR /app

# 安装依赖（跳过 postinstall，因为 Prisma schema 尚未复制）
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# 复制 Prisma schema 并生成客户端
COPY prisma ./prisma/
RUN npx prisma generate

# 复制源代码
COPY . .

# 构建 Next.js 应用
RUN npm run build

# ==================== 运行阶段 ====================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# 安装 wget 用于健康检查
RUN apk add --no-cache wget

# 复制构建产物
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# public 目录从构建上下文直接复制（standalone 模式不包含）
COPY public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# 复制启动脚本（含 prisma db push）
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# 创建数据目录
RUN mkdir -p /app/data

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/ || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
