# 快速开始

## 本地开发

### 1. 安装依赖

```bash
git clone -b canary https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
npm install --legacy-peer-deps
```

### 2. 配置环境变量

```bash
cat > .env << 'EOF'
DB_TYPE=tidb
DATABASE_URL=mysql://用户名:密码@host:4000/dbname?sslaccept=accept_invalid_certs
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的密码
JWT_SECRET=至少32字符的随机密钥
EOF
```

### 3. 初始化数据库

```bash
DB_PUSH=1 node scripts/prepare-db.mjs
```

`npm install` / `npm run dev` 会自动生成 Prisma Client，但**本地默认不会同步表结构**（防止误操作真实数据库）。首次开发需手动执行上面的命令，将表结构推送到 `.env` 中 `DATABASE_URL` 指向的数据库（`DB_TYPE` 会按 `DATABASE_URL` 协议自动推断）。

### 4. 启动开发服务器

```bash
npm run dev
```

### 5. 访问管理后台

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
- [环境变量](/deployment/env) — 完整环境变量参考
