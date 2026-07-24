# Fiammetta Watcher Proxy

LLM API 中转站，支持多平台负载均衡、熔断恢复、SSE 流式响应。部署在 Cloudflare 全球边缘网络。

## 功能特性

- **多平台负载均衡** — 多上游 API 平台，按优先级、权重、健康状态自动路由
- **熔断恢复** — 平台故障自动熔断，恢复后自动切回
- **SSE 流式响应** — 完整支持主流 LLM 平台的流式响应格式
- **管理后台** — 平台、密钥、模型映射、日志、审计的可视化管理
- **定时任务** — Key 用量自动重置、平台模型自动发现、日志自动归档

## 架构

```
用户请求 → Cloudflare Worker（代理 v1/* + Cron 任务）
         → Cloudflare Pages（管理后台 + API 路由）
         → D1 数据库
         → KV 命名空间（登录限流 + 熔断状态）
```

## 部署

### 方式一：GitHub Actions 自动部署（推荐）

推送到 `feat/cloudflare-workers` 分支自动触发部署。工作流步骤：

1. **初始化资源（pre）** — `deploy/init.py pre` 创建 D1/KV + 替换配置占位符
2. **安装依赖** — `npm install` + 生成 Prisma Client
3. **构建** — `npm run build:cf`（OpenNext 构建 + 产物整理）
4. **部署 Worker** — `wrangler deploy`（API 代理 + Cron）
5. **初始化绑定和 Secrets（post）** — `deploy/init.py post` 创建 Pages + 绑定 + 设置所有 Secrets
6. **部署 Pages** — `wrangler pages deploy .open-next`（管理后台）

需要在 GitHub 仓库 Settings → Secrets 中配置：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（Edit 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID |
| `ADMIN_USERNAME` | 管理员用户名 |
| `ADMIN_PASSWORD` | 管理员密码 |

### 方式二：手动部署

#### 前置条件

- Node.js 22+
- Cloudflare 账号 + API Token

#### 步骤

```bash
# 1. 安装依赖
npm install

# 2. 登录 Wrangler（或设置 CLOUDFLARE_API_TOKEN 环境变量）
npx wrangler login

# 3. 初始化资源（创建 D1/KV + 替换配置占位符）
python3 deploy/init.py pre

# 4. 构建
npm run build:cf

# 5. 部署 Worker
cd worker && npx wrangler deploy && cd ..

# 6. 初始化绑定和 Secrets（Pages 绑定 + 所有 Secrets）
python3 deploy/init.py post

# 7. 部署 Pages
npx wrangler pages deploy .open-next --project-name fiammetta-watcher --branch main
```

### 环境变量

| 变量 | 说明 |
|------|------|
| `ADMIN_USERNAME` | 管理员用户名 |
| `ADMIN_PASSWORD` | 管理员密码 |
| `JWT_SECRET` | JWT 签名密钥（留空自动生成） |
| `DATABASE_URL` | 外部数据库 URL（PostgreSQL/MySQL，D1 通过 binding 连接无需设置） |

## 开发

```bash
npm run dev          # 本地开发
npm run build        # Next.js 构建
npm run build:cf     # Cloudflare 构建
npm run preview      # Cloudflare 本地预览
npm run test         # 运行测试
```

## 技术栈

- **运行时**: Cloudflare Workers + Pages（OpenNext）
- **框架**: Next.js 16 + React 19
- **数据库**: Cloudflare D1（Prisma 7 ORM）
- **缓存**: Cloudflare KV
- **UI**: Ant Design 6 + Tailwind CSS
- **图表**: Recharts
- **认证**: JWT（jose）

## 许可证

[Apache License 2.0](LICENSE)

## 免责声明

本项目为独立开发的开源软件，与任何大语言模型服务提供商（包括但不限于 OpenAI、Anthropic、Google 等）无任何关联、赞助或授权关系。

本项目仅提供 API 请求转发功能，不对通过本项目转发的任何请求内容、响应内容或使用行为承担法律责任。使用者应自行确保其使用方式符合所连接平台的服务条款及相关法律法规。

本项目按「现状」提供，不作任何明示或暗示的保证。作者不对因使用本项目而产生的任何直接或间接损失承担责任。
