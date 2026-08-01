# Cloudflare 部署

FWP 部署到 Cloudflare 后由两部分组成：**Worker** 处理 `/v1/*` 代理与 3 个定时任务，**Pages** 托管前台与管理后台，两者共享同一个数据库。

- 数据库默认 `DB_TYPE=d1`（Cloudflare D1，免费，无需任何配置）；也可用 TiDB/PG
- 推荐使用 GitHub Actions 自动部署：推送代码即完成全部发布

## 前置条件

- [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费即可；生产建议 Workers 付费计划，见[常见问题](#常见问题)）
- GitHub 账号

## 方式一：GitHub Actions 自动部署（推荐）

全程网页操作，无需本地终端。

### 1. Fork 项目

打开 [Fiammetta-Watcher-Proxy](https://github.com/Jyf0214/Fiammetta-Watcher-Proxy)，点右上角 Fork 复制到你的 GitHub 账号。

### 2. 启用工作流

进入 Fork 后仓库的 Actions 页面，按提示启用工作流（首次可能需要批准）。

### 3. 配置 GitHub Secrets

仓库 Settings → Secrets and variables → Actions → New repository secret：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（账号级 Edit 权限，[创建地址](https://dash.cloudflare.com/profile/api-tokens)） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID（Dashboard 右侧栏） |
| `ADMIN_USERNAME` | 管理后台登录用户名 |
| `ADMIN_PASSWORD` | 管理后台登录密码（**必填**，缺失则部署失败） |
| `DB_TYPE` | 数据库类型，默认 `d1`；用 TiDB/PG 时设为 `tidb`/`pg` |
| `DATABASE_URL` | 外部数据库连接串（仅 `DB_TYPE=tidb/pg` 时需要） |

### 4. 触发部署

Actions 页面 → 左侧 Deploy 工作流 → Run workflow → **分支选择 `canary`**（Fork 后的默认分支不是 `canary`，务必手动选择）→ 平台选择 `cf` → 点击 Run workflow。

运行后自动完成：创建数据库与缓存资源 → 构建 → 部署 Worker → 部署 Pages → 配置后台登录凭据。全程无需登录 Cloudflare 控制台。

### 5. 验证

| 检查项 | 地址 |
|--------|------|
| 健康检查 | `curl -H "Authorization: Bearer <系统API Key>" https://<项目名>.pages.dev/api/health` → `{"status":"ok",...}`（需管理员认证） |
| 代理可用 | `https://<worker名>.<账号>.workers.dev/v1/models`（无 API Key 返回 401 即正常） |
| 管理后台 | `https://<项目名>.pages.dev/admin`，用 Secrets 里的账号密码登录 |

> Worker 与 Pages 的域名在 Dashboard → Workers & Pages 中查看。生产环境建议绑定自定义域名（Dashboard → 项目 → Custom domains）。

## 方式二：手动部署（Wrangler，调试用）

### 1. 登录并创建资源

```bash
npx wrangler login

# 创建 D1 数据库，记下输出的 database_id
npx wrangler d1 create fiammetta_d1

# 创建 KV 命名空间，记下输出的 id
npx wrangler kv namespace create fiammetta-proxy
```

### 2. 配置 worker/wrangler.toml

把上一步的 ID 填入：

```toml
name = "fiammetta_worker"
main = "src/index.ts"
compatibility_date = "2025-04-02"
compatibility_flags = ["nodejs_compat"]

[placement]
mode = "smart"

[vars]
DB_TYPE = "d1"                     # 或 tidb / pg

[[d1_databases]]
binding = "DB"
database_name = "fiammetta_d1"
database_id = "你的-d1-database-id"

[[kv_namespaces]]
binding = "KV"
id = "你的-kv-namespace-id"

[triggers]
crons = ["0 */6 * * *", "0 */1 * * *", "0 3 * * *"]
```

### 3. 初始化数据库

```bash
npx wrangler d1 execute fiammetta_d1 --file=init.sql --remote
```

（`init.sql` 在项目根目录。）

### 4. 构建并部署 Worker

```bash
npm run build:cf
cd worker
npx wrangler deploy --config wrangler.toml
```

### 5. 部署 Pages

```bash
npx wrangler pages deploy .open-next --project-name fiammetta-watcher --branch main
```

> 必须部署 `.open-next` 目录，不是 `.open-next/assets`——部署 assets 会退化为纯静态站点，管理后台全部 404。

### 6. 配置 Pages 后台凭据与绑定

Pages 需要数据库/缓存绑定和后台登录凭据。导出两个环境变量后运行：

```bash
export CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=xxx
python3 deploy/init.py post
python3 deploy/init.py post-deploy
```

（本地运行前需 `pip install requests`。也可以在 Dashboard → Workers & Pages → 项目 → Settings 中手动配置。）

## 定时任务

| 任务 | Cron | 频率 | 功能 |
|------|------|------|------|
| 模型发现 | `0 */6 * * *` | 每 6 小时 | 自动发现各平台可用模型 |
| Key 用量重置 | `0 */1 * * *` | 每小时 | 按周期重置 Key 用量 |
| 日志归档 | `0 3 * * *` | 每天 3:00 | 归档 30 天前的请求日志 |

已随 Worker 自动部署；也可在 Dashboard → Worker → Settings → Triggers → Cron Triggers 查看修改。

## 常见问题

### 免费版请求频繁失败（CPU 超时）

Workers 免费版单请求 CPU 上限 **10ms**，代理 AI 流式请求很容易超限。生产建议升级 Workers Paid（CPU 上限默认 30s，最高 5 分钟），或改用 [Vercel](/deployment/vercel) / [EdgeOne](/deployment/edgeone)。

### D1 免费额度

5GB 存储、5M 行读取/天、100k 行写入/天。用量统计与日志归档会消耗行数，流量大时留意（Dashboard → D1 → 用量）。

### 流式响应中断

免费版下较常见。注意 120 秒是应用对上游请求的默认超时（各平台一致），免费版流式中断更常见的原因是 CPU 10ms 超限（见上）。升级付费计划或换平台可改善。

### 部署后管理后台 404

方式二部署时检查是否部署了 `.open-next` 目录（不是 `.open-next/assets`）。

## 相关文档

- [架构说明](/deployment/architecture)
- [环境变量](/deployment/env)
- [Wrangler 文档](https://developers.cloudflare.com/workers/wrangler/)
