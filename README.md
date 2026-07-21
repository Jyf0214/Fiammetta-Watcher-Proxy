# Fiammetta Watcher Proxy

OpenAI 兼容 API 中转站，支持多平台负载均衡、熔断恢复、SSE 流式响应。部署在 Cloudflare 全球边缘网络，无需自有服务器。

## 功能特性

- **多平台负载均衡** — 支持多个上游 API 平台，按优先级、权重、健康状态自动路由
- **熔断恢复** — 平台故障自动熔断，恢复后自动切回，避免请求堆积
- **SSE 流式响应** — 完整支持 OpenAI Streaming API
- **管理后台** — 可视化管理平台、密钥、模型映射、代理、日志、审计
- **定时任务** — API Key 用量自动重置、平台模型自动发现、日志自动归档
- **零服务器** — 全部运行在 Cloudflare 边缘，无需维护任何服务器

## 架构

```
用户请求 → Cloudflare Worker（代理 + 定时任务）
         → Cloudflare Pages（管理后台 + API）
         → D1 数据库（SQLite）
         → KV 命名空间（缓存 + 熔断状态）
```

| 组件 | 职责 |
|------|------|
| **Worker** | 代理 OpenAI API 请求（`v1/*`），处理定时任务（Cron Triggers） |
| **Pages** | 管理后台前端 + 管理 API（平台/密钥/模型/日志等 CRUD） |
| **D1** | 存储所有业务数据（平台、密钥、模型映射、日志等） |
| **KV** | 存储速率限制、熔断器状态、路由缓存 |

## 部署

### 前置条件

- Node.js 18+
- 一个 Cloudflare 账号
- 一个 GitHub 账号（用于克隆代码）

### 第一步：获取 Cloudflare API Token

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 **My Profile → API Tokens**
3. 点击 **Create Token**
4. 选择 **Edit Cloudflare Workers** 模板（或自定义权限）
5. 确保 Token 拥有以下权限：
   - `Account → Workers Scripts: Edit`
   - `Account → D1: Edit`
   - `Account → KV Storage: Edit`
   - `Account → Pages: Edit`
6. 创建后**立即复制 Token**（只显示一次）

### 第二步：克隆项目并安装依赖

```bash
git clone https://github.com/你的用户名/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy

# 安装 Worker 依赖
cd worker && npm install

# 安装前端依赖
cd ../frontend && npm install
cd ..
```

### 第三步：登录 Wrangler

```bash
npx wrangler login
```

浏览器会弹出 Cloudflare 授权页面，登录后授权即可。也可以直接设置环境变量：

```bash
export CLOUDFLARE_API_TOKEN=你的API_Token
```

### 第四步：创建 Cloudflare 资源

#### 创建 D1 数据库

```bash
cd worker
npx wrangler d1 create fiammetta-proxy
```

命令输出类似：

```
✅ Created database 'fiammetta-proxy'
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**复制 `database_id` 的值**，打开 `worker/wrangler.toml`，将 `<YOUR_D1_DATABASE_ID>` 替换为该值。同样打开 `frontend/wrangler.toml` 做相同替换。

#### 创建 KV 命名空间

```bash
npx wrangler kv namespace create fiammetta-proxy
```

命令输出类似：

```
✅ Created namespace 'fiammetta-proxy'
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

**复制 `id` 的值**，打开 `worker/wrangler.toml`，将 `<YOUR_KV_NAMESPACE_ID>` 替换为该值。同样打开 `frontend/wrangler.toml` 做相同替换。

### 第五步：初始化数据库

```bash
npx wrangler d1 execute fiammetta-proxy --file=drizzle/0000_init.sql --remote
```

执行成功后会显示 `✅ Successfully executed SQL`。

### 第六步：部署 Worker

```bash
npx wrangler deploy
```

部署成功后会输出 Worker 的访问地址，格式为：

```
https://fiammetta-watcher.你的子域名.workers.dev
```

### 第七步：部署 Pages（管理后台）

```bash
cd ../frontend
npm run build
npx wrangler pages deploy dist --project-name=fiammetta-watcher
```

部署成功后会输出 Pages 的访问地址，格式为：

```
https://fiammetta-watcher.pages.dev
```

### 第八步：配置 Pages 绑定

Pages 需要访问 D1 和 KV 才能正常工作。在 Cloudflare Dashboard 中操作：

1. 进入 **Workers & Pages → fiammetta-watcher → Settings → Functions**
2. 滚动到 **Bindings** 部分
3. 点击 **Add binding**，添加以下两个绑定：

| 绑定类型 | 绑定名称 | 选择资源 |
|----------|----------|----------|
| D1 Database | `DB` | 第四步创建的 `fiammetta-proxy` 数据库 |
| KV Namespace | `KV` | 第四步创建的 `fiammetta-proxy` 命名空间 |

### 第九步：配置环境变量

1. 在 Cloudflare Dashboard 中进入 **Workers & Pages → fiammetta-watcher → Settings → Environment variables**
2. 展开 **Production** 环境
3. 添加以下变量：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `ENVIRONMENT` | `production` | 运行环境标识，影响 Cookie 安全标志和调试端点访问控制 |
| `ADMIN_USERNAME` | `admin`（或自定义） | 管理员用户名 |
| `ADMIN_PASSWORD` | 你的密码 | 管理员登录密码 |
| `JWT_SECRET` | 运行 `openssl rand -base64 32` 生成 | JWT 签名密钥 |

> ⚠️ 所有变量添加后，点击 **Encrypt** 加密保存。

### 第十步：验证部署

1. 打开 Pages 地址（如 `https://fiammetta-watcher.pages.dev`）
2. 使用第九步配置的管理员账号密码登录
3. 登录成功后，在「平台管理」中添加一个上游 API 平台
4. 在「密钥管理」中创建一个 API Key
5. 使用创建的 Key 测试代理请求：

```bash
curl https://fiammetta-watcher.你的子域名.workers.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer fwp-xxxxxxxx" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"你好"}]}'
```

## 常见问题

### 部署时报错 " Unauthorized"

Cloudflare API Token 权限不足或已过期。重新创建 Token 并确保包含 Workers/D1/KV/Pages 的 Edit 权限。

### 管理后台无法登录

确认 `ADMIN_PASSWORD` 已在 Pages 环境变量中设置。如果忘记了密码，在环境变量中重新设置后等待 1-2 分钟生效。

### Worker 返回 404

确认 Worker 和 Pages 都已部署成功。API 请求走 Worker（`v1/*` 路径），管理后台走 Pages。

### 数据库表不存在

确保执行了第五步的 `wrangler d1 execute` 命令。如果命令报错，检查 `database_id` 是否正确替换到了 `wrangler.toml` 中。

### Pages 绑定后 Functions 报错

在 Cloudflare Dashboard 的 Pages 项目中，进入 **Settings → Functions → Bindings**，确认 D1 和 KV 绑定名称分别为 `DB` 和 `KV`（区分大小写）。

## 定时任务

Worker 自动运行以下定时任务，无需手动触发：

| 任务 | 周期 | 说明 |
|------|------|------|
| API Key 用量重置 | 每小时 | 检查并重置到期的 Key 用量 |
| 平台模型发现 | 每 10 分钟 | 自动获取各平台可用模型列表 |
| 日志归档 | 每天凌晨 3 点 | 将请求日志聚合为统计数据 |

## 技术栈

- **运行时**: Cloudflare Workers + Pages Functions
- **数据库**: Cloudflare D1（SQLite）
- **缓存**: Cloudflare KV
- **后端框架**: Hono
- **前端框架**: React + Vite + Tailwind CSS
- **ORM**: Drizzle ORM
- **UI 组件**: Lobe UI
- **认证**: JWT（jose）+ PBKDF2 密码哈希

## 许可证

[Apache License 2.0](LICENSE)
