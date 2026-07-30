# 快速开始

## 方式一：Cloudflare 部署（推荐）

最简单的部署方式，零运维成本，全球边缘节点。

### 前置条件

- [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费）
- [GitHub 账号](https://github.com)

### 步骤

1. Fork 项目到你的 GitHub 账号
2. 获取 [Cloudflare API Token](https://dash.cloudflare.com/profile/api-tokens)（权限：Workers Edit、D1 Edit、Pages Edit）
3. 运行初始化脚本：

```bash
git clone https://github.com/你的用户名/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
pip install -r deploy/requirements.txt
export CLOUDFLARE_API_TOKEN="你的Token"
export CLOUDFLARE_ACCOUNT_ID="你的账号ID"
python deploy/init.py
```

4. 在 GitHub 仓库 Settings → Secrets 中添加 `init.py` 输出的 ID
5. 在 Cloudflare Dashboard → Worker → Settings → Variables 中设置 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`
6. 推送代码到 `main` 分支，自动触发部署

详见 [Cloudflare 部署](/deployment/cloudflare)。

## 方式二：本地开发

### 1. 安装依赖

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
npm install
```

### 2. 配置环境变量

```bash
cat > .env << 'EOF'
DB_TYPE=tidb
DATABASE_URL=mysql://用户名:密码@host:4000/dbname?sslaccept=accept_invalid_certs
ADMIN_USERNAME=admin
ADMIN_PASSWORD=你的密码
JWT_SECRET=
EOF
```

### 3. 初始化数据库

```bash
node scripts/prepare-db.mjs
```

### 4. 启动开发服务器

```bash
npm run dev
```

### 5. 访问管理后台

打开 `http://localhost:3000/admin`，使用配置的管理员账号登录。

## 方式三：Vercel 部署

1. 在 [Vercel Dashboard](https://vercel.com/dashboard) 导入 GitHub 仓库
2. 框架预设选择 Next.js
3. 添加环境变量（`DB_TYPE`、`DATABASE_URL`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`）
4. 部署

详见 [Vercel 部署](/deployment/vercel)。

## 方式四：Node.js 直接运行

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
git checkout feat/cloudflare-workers
npm install
# 配置 .env 文件（见方式二）
node scripts/prepare-db.mjs
npm run build
npm start
```

详见 [Node.js 直接部署](/deployment/standalone)。

## 下一步

- [平台配置](/guide/platform) — 配置上游 AI 服务提供商
- [API Key 管理](/guide/api-key) — 创建和管理 API Key
- [模型映射](/guide/model-map) — 配置模型名称映射
- [环境变量](/deployment/env) — 完整环境变量参考
