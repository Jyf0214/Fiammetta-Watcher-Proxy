# Fiammetta-Watcher-Proxy — OpenAI 中转站路由 项目计划

## 需求摘要

| 维度 | 决策 |
|------|------|
| **核心功能** | API Key 管理 + 多平台路由（权重负载均衡 + 自动熔断恢复） |
| **上游平台** | 完全自定义，支持任意 OpenAI 兼容平台 |
| **认证模式** | 仅管理员模式 |
| **管理后台** | 完整后台（Antd Pro 风格） |
| **模型路由** | 同时支持按模型名路由和按平台路由 |
| **流式响应** | 支持 SSE Streaming（App Router ReadableStream） |
| **请求日志** | 详细日志（时间、Key、模型、状态码、token 用量、耗时） |
| **数据库** | PostgreSQL + MySQL 均支持，通过环境变量切换 |
| **Docker** | docker-compose 全家桶 + Dockerfile 独立部署 |
| **国际化** | 中英文双语（i18next） |
| **用量控制** | Token 额度 + 调用频次 + RPM/TPM 限速 |
| **审计日志** | 系统事件日志 + 错误详情日志 |
| **限速控制** | 按平台级 RPM/TPM 限制 |
| **协议支持** | Chat Completions + Completions |
| **部署方式** | 仅 Docker（Next.js standalone） |
| **管理员初始化** | 环境变量设置账号密码，首次启动自动初始化 |
| **通知功能** | Key 额度用尽、平台故障、系统异常时通知管理员 |

---

## 技术栈

| 类别 | 选型 |
|------|------|
| 框架 | Next.js 16 (standalone mode) |
| UI 库 | antd (ProComponents / ProLayout) |
| 样式 | TailwindCSS 4 |
| 图表 | Chart.js + chartjs-adapter-moment |
| 国际化 | i18next + i18next-browser-languagedetector |
| 动画 | motion (Framer Motion) |
| 图标 | lucide-react |
| 认证 | jsonwebtoken |
| ORM | Prisma (schema.prisma 唯一表结构来源) |
| 数据库 | PostgreSQL / MySQL（通过 DATABASE_URL 切换） |
| 部署 | Docker + docker-compose |

---

## 数据库模型设计（Prisma Schema）

### 模型关系

```
Admin ─┐
       ├─→ ApiKey ──→ Plan（可选，套餐模板继承限额）
       ├─→ Platform ──→ ModelMap
       ├─→ RequestLog（关联 ApiKey + Platform）
       ├─→ AuditLog（关联 Admin）
       ├─→ SystemEvent
       └─→ Config
```

### 关键模型

| 模型 | 用途 | 核心字段 |
|------|------|---------|
| **Admin** | 管理员账户 | id, username, passwordHash, createdAt |
| **Platform** | 上游平台 | id, name, baseUrl, apiKey, type, enabled, priority, weight, rpmLimit, tpmLimit, status, failCount, lastFailAt, cooldownEnd |
| **ApiKey** | 分发给用户的 API Key | id, key, name, planId（可选）, quota, usedTokens, rpmLimit, tpmLimit, callLimit, tokenLimit, resetPeriod, status, expiresAt |
| **Plan** | 套餐模板（可复用） | id, name, tokenQuota, callLimit, rpmLimit, tpmLimit, resetPeriod |
| **ModelMap** | 模型映射表 | id, alias, targetModel, platformId |
| **RequestLog** | 请求日志 | id, keyId, platformId, model, status, tokens, duration, isError, errorMessage, createdAt |
| **AuditLog** | 审计日志 | id, adminId, action, detail, ip, createdAt |
| **SystemEvent** | 系统事件 | id, level, message, detail, createdAt |
| **Config** | 系统配置 | id, key, value, updatedAt |

### ApiKey 与 Plan 的关系

- ApiKey 有可选的 `planId` 外键引用 Plan
- **有 Plan 时**：ApiKey 继承 Plan 的限额，同时 ApiKey 自身的对应字段作为覆盖值（null 表示使用 Plan 默认值）
- **无 Plan 时**：ApiKey 使用自身设置的所有限额字段

---

## SSE 流式响应架构

- **实现方式**：Next.js App Router Route Handler 直接返回 `Response` 对象，body 使用 `ReadableStream`
- **代理逻辑**：Route Handler 通过 `fetch` 请求上游 API（`stream: true`），将上游的 SSE 事件流透传给客户端
- **反向代理要求**：文档注明需在 nginx/Caddy 等反向代理中对 `/v1/*` 路由禁用 `proxy_buffering`
- **错误处理**：流式响应中断时记录错误日志，通知客户端连接异常

---

## 项目结构

```
Fiammetta-Watcher-Proxy/
├── prisma/
│   └── schema.prisma
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── admin/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx
│   │   │   ├── platforms/
│   │   │   ├── keys/
│   │   │   ├── models/
│   │   │   ├── logs/
│   │   │   ├── audit/
│   │   │   ├── system/
│   │   │   └── events/
│   │   └── api/
│   │       ├── v1/
│   │       │   ├── chat/completions/
│   │       │   └── completions/
│   │       └── admin/
│   │           ├── auth/
│   │           ├── platforms/
│   │           ├── keys/
│   │           ├── models/
│   │           ├── logs/
│   │           └── config/
│   ├── components/
│   ├── lib/
│   │   ├── prisma.ts
│   │   ├── auth.ts
│   │   ├── router.ts
│   │   ├── rate-limiter.ts
│   │   ├── circuit-breaker.ts
│   │   ├── notifier.ts
│   │   └── i18n.ts
│   ├── services/
│   └── types/
├── messages/
│   ├── zh.json
│   └── en.json
├── public/
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── next.config.ts
├── tailwind.config.ts
└── package.json
```

---

## 实施计划

### 阶段一：项目初始化与基础架构
1. 初始化 Next.js 16 项目，安装所有依赖
2. 配置 Prisma，定义 schema.prisma
3. 创建项目目录结构，建立分层架构
4. 配置 TailwindCSS 4 + antd
5. 配置 i18next 中英文国际化
6. 配置 Docker（Dockerfile + docker-compose.yml）

### 阶段二：核心后端逻辑
7. Prisma 客户端单例 + 数据库连接管理
8. JWT 认证模块
9. 管理员初始化（环境变量 → 首次启动自动创建）
10. 请求路由引擎（按模型名/按平台路由，权重分配）
11. SSE 流式响应处理
12. 速率限制器（按平台 RPM/TPM）
13. 熔断器（自动熔断 + 冷却恢复）
14. 通知服务
15. 请求日志记录（异步写入）

### 阶段三：管理后台 API
16. 管理员认证 API
17. 平台管理 CRUD API
18. API Key 管理 API
19. 模型映射 API
20. 请求日志查询 API
21. 系统配置 API
22. 审计日志 API
23. 用量统计 API

### 阶段四：管理后台前端
24. 登录页面
25. 后台布局（ProLayout）
26. 仪表盘页面（Chart.js）
27. 平台管理页面
28. API Key 管理页面
29. 模型映射管理页面
30. 请求日志页面
31. 审计日志页面
32. 系统配置页面
33. 系统事件页面

### 阶段五：代理接口与测试
34. Chat Completions 代理接口
35. Completions 代理接口
36. 负载均衡 + 故障转移测试
37. SSE 流式响应测试
38. 速率限制 + 熔断器测试

### 阶段六：部署与文档
39. Docker 构建测试
40. docker-compose 部署测试
41. README.md 编写

---

## 关键技术约束

- 数据库操作永远使用 Prisma，禁止 raw SQL / execSync
- 环境变量缺失时系统进入限制模式
- 所有 API 错误显式展示，禁止静默处理
- 所有服务器交互有明确反馈
- 提交者署名：Jyf0214，邮箱：169313142+Jyf0214@users.noreply.github.com
