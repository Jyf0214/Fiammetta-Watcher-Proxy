# 部署指南

FWP 支持多种部署方式，推荐使用 Docker。

## 部署方式对比

| 方式 | 适用场景 | 难度 |
|------|----------|------|
| [Docker Compose](/deployment/docker) | 生产环境推荐 | ⭐ |
| [Docker 单容器](/deployment/docker#单独使用-docker) | 轻量部署 | ⭐ |
| [Node.js 直接运行](/deployment/standalone) | 无 Docker 环境、开发调试 | ⭐⭐ |

## 资源需求

### 最低配置
- 1 vCPU
- 512MB 内存
- 10GB 磁盘

### 推荐配置
- 2 vCPU
- 1GB 内存
- 20GB 磁盘

## 数据库要求

FWP 使用 Prisma ORM，支持以下数据库：

- **PostgreSQL**（推荐）— 完整功能支持
- **MySQL** — 完整功能支持
- **TiDB Cloud** — 兼容 MySQL 协议

### 数据库优化

Prisma 默认连接池设置可能不适合小内存环境。FWP 已自动优化：

```
connection_limit=5&pool_timeout=10
```

## 下一步

- [Docker 部署](/deployment/docker) — 使用 Docker Compose 快速部署
- [Node.js 直接部署](/deployment/standalone) — 不使用 Docker 的完整部署指南
- [环境变量配置](/deployment/env) — 所有环境变量说明
- [Nginx 配置](/deployment/nginx) — 反向代理和 HTTPS 配置
