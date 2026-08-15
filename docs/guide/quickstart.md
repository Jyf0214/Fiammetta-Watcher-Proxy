# 快速开始

## 本地开发

### 1. 安装依赖

```bash
git clone -b canary https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
npm install --legacy-peer-deps
```

### 2. 配置管理员账号

本地开发**无需配置数据库**：`npm run dev` 会自动拉起嵌入式 PostgreSQL（数据存放在 `.pgdata/`）并写入 `.env.local`（`DB_TYPE=pg` + `DB_PUSH=1`，prepare-db 优先读取 `.env.local`）。只需配置管理员登录：

```bash
cat > .env << 'EOF'
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的密码
JWT_SECRET=至少32字符的随机密钥
EOF
```

### 3. 启动开发服务器

```bash
npm run dev
```

`npm install` / `npm run dev` 会自动生成 Prisma Client，并**自动同步表结构到本地嵌入式 PostgreSQL**（predev 钩子执行 `dev-postgres.mjs --ensure` + `prepare-db.mjs`），无需手动建表。

### 4. 访问管理后台

打开 `http://localhost:3000/admin`，使用配置的管理员账号登录。

## 部署到生产

项目支持 Cloudflare、Vercel、EdgeOne、Node.js、Docker 多种部署方式，完整部署教程与平台对比见 [部署指南](/deployment/)，各平台详细步骤见对应文档：

- [Cloudflare 部署](/deployment/cloudflare)
- [Vercel 部署](/deployment/vercel)
- [EdgeOne 部署](/deployment/edgeone)
- [Node.js 直接部署](/deployment/standalone)
- [Docker 部署](/deployment/docker)

## 下一步

- [平台配置](/guide/platform) — 配置上游 AI 服务提供商
- [API Key 管理](/guide/api-key) — 创建和管理 API Key
- [模型映射](/guide/model-map) — 配置模型名称映射
- [API 参考](/api/) — 各端点调用方式
- [环境变量](/deployment/env) — 完整环境变量参考
