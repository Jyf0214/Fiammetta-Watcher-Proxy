# 架构说明

FWP 是一套 AI 网关服务：对外提供 OpenAI 兼容的代理接口，对内提供管理后台（管理 API Key、模型、用量与日志）。部署方式分为两种运行模式，你选择的平台决定走哪一种。

## 两种运行模式

### Cloudflare 模式（托管）

```
请求 → 代理接口与定时任务（Cloudflare 托管运行）
     → 前端与管理后台（Cloudflare 托管运行）
              ↓
         D1 数据库（Cloudflare 内置）
```

- 对外代理接口与 3 个定时任务（模型发现、Key 用量重置、日志归档）全部由 Cloudflare 托管运行，不占你自己的服务器资源
- 前端与管理后台同样托管在 Cloudflare
- 数据存于 Cloudflare 内置的 D1 数据库，免费额度内无需自备数据库
- 定时任务由平台内置调度，免费自动执行

### 自托管式（Vercel / EdgeOne / 自有服务器）

```
请求 → Next.js 服务
     ├── 代理接口 /v1/*
     ├── 定时任务端点 /api/cron/*（需外部定时调用）
     ├── 管理后台
     └── 前端页面
              ↓
         TiDB / MySQL / MariaDB / PostgreSQL（远程数据库）
```

- 整个应用运行在一个服务里（Vercel / EdgeOne 的 Serverless 函数，或你自己的服务器）
- 数据库需要自己准备：TiDB Cloud（免费档）、MySQL、MariaDB 或 PostgreSQL，通过连接串连接
- 定时任务：Docker 部署由容器内部定时器自动执行；其他部署需用外部服务定时调用各端点（见各平台文档）
- 非 Cloudflare 平台的管理 API 限流（进程内滑动窗口）在服务重启（冷启动）后会清零，属正常现象，不影响功能；登录限流基于数据库记录，重启后依然生效

## 平台差异一览

| 项目 | Cloudflare | Vercel / EdgeOne | 自有服务器 |
|------|-----------|------------------|-----------|
| 数据库 | D1 内置（免费） | 自备 TiDB / MySQL / MariaDB / PostgreSQL | 自备 |
| 定时任务 | 内置免费 | 外部调度（Vercel Cron 需付费版） | 系统 cron（Node.js 直部署）/ Docker 内置自动 |
| 登录限流 | 重启后依然生效（存数据库） | 重启后依然生效（存数据库） | 重启后依然生效（存数据库） |
| 管理 API 限流 | KV 持久化，重启后依然生效 | 进程内存，重启后清零 | 进程内存，重启后清零 |

> 管理后台登录限流：30 分钟内连续失败 5 次会临时限制登录，过一段时间再试即可。

## 相关文档

- [部署指南](/deployment/) — 平台对比与选择
- [Cloudflare 部署](/deployment/cloudflare)
- [Vercel 部署](/deployment/vercel)
- [EdgeOne 部署](/deployment/edgeone)
- [环境变量](/deployment/env)
