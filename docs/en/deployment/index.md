# Deployment Guide

FWP supports multiple deployment methods. Docker is recommended.

## Deployment Options

| Method | Use Case | Difficulty |
|--------|----------|------------|
| [Docker Compose](/en/deployment/docker) | Recommended for production | ⭐ |
| [Docker standalone](/en/deployment/docker#standalone-docker) | Lightweight deployment | ⭐ |
| [Node.js Standalone](/en/deployment/standalone) | No Docker environment, development/debugging | ⭐⭐ |

## Resource Requirements

### Minimum
- 1 vCPU
- 512MB RAM
- 10GB disk

### Recommended
- 2 vCPU
- 1GB RAM
- 20GB disk

## Database Requirements

FWP uses Prisma ORM and supports:

- **PostgreSQL** (recommended) — Full feature support
- **MySQL** — Full feature support
- **TiDB Cloud** — MySQL-compatible protocol

### Connection Pool Optimization

Prisma default settings are optimized for small environments:

```
connection_limit=5&pool_timeout=10
```

## Next Steps

- [Docker Deployment](/en/deployment/docker) — Quick deployment with Docker Compose
- [Node.js Standalone](/en/deployment/standalone) — Complete guide without Docker
- [Environment Variables](/en/deployment/env) — All environment variable reference
- [Nginx Configuration](/en/deployment/nginx) — Reverse proxy and HTTPS setup
