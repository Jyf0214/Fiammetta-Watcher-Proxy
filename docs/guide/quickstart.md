# 快速开始

## 方式一：Cloudflare 部署（推荐）

最简单的部署方式，零运维成本，全球边缘节点。

### 前置条件

- [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费）
- [GitHub 账号](https://github.com)

### 步骤

1. Fork 项目到你的 GitHub 账号
2. 获取 [Cloudflare API Token](https://dash.cloudflare.com/profile/api-tokens)（权限：Workers Edit、Workers KV Storage Edit、D1 Edit、Pages Edit）
3. 在仓库 Settings → Secrets and variables → Actions 配置以下 Secret：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | 你的 Cloudflare API Token |
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Cloudflare 账号 ID（Dashboard 右侧栏） |
| `ADMIN_USERNAME` | 管理后台登录用户名 |
| `ADMIN_PASSWORD` | 管理后台登录密码 |
| `DB_TYPE` | 数据库类型，默认 `d1`，无需自备数据库 |

4. 在 Actions 页面启用工作流（首次按提示启用/批准）
5. 手动运行工作流：Actions → Deploy → Run workflow → 分支选择 `canary` → 平台选择 `cf` → 点击 Run workflow。自动完成部署（数据库、Worker、Pages、后台登录凭据全部自动配置）

详见 [Cloudflare 部署](/deployment/cloudflare)。

## 方式二：本地开发

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

### 3. 启动开发服务器

```bash
npm run dev
```

### 4. 访问管理后台

打开 `http://localhost:3000/admin`，使用配置的管理员账号登录。

## 方式三：Vercel 部署

1. 在 [Vercel Dashboard](https://vercel.com/dashboard) 导入 GitHub 仓库
2. 框架预设选择 Next.js
3. 添加环境变量（`DB_TYPE`、`DATABASE_URL`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`JWT_SECRET`）
4. 部署

详见 [Vercel 部署](/deployment/vercel)。

## 方式四：Node.js 直接运行

```bash
git clone -b canary https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
npm install --legacy-peer-deps
# 配置 .env 文件（见方式二）
npm run build
npx next start
```

详见 [Node.js 直接部署](/deployment/standalone)。

## 下一步

- [平台配置](/guide/platform) — 配置上游 AI 服务提供商
- [API Key 管理](/guide/api-key) — 创建和管理 API Key
- [模型映射](/guide/model-map) — 配置模型名称映射
- [环境变量](/deployment/env) — 完整环境变量参考
