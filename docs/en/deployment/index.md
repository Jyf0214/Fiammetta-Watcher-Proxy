# Deployment Guide

FWP supports multiple deployment methods. Docker is recommended.

## Deployment Options

| Method | Use Case | Difficulty |
|--------|----------|------------|
| Docker Compose | Recommended for production | ⭐ |
| Docker standalone | Lightweight deployment | ⭐ |
| Node.js direct | Development/debugging | ⭐⭐ |

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

### Connection Pool Optimization

Prisma default settings are optimized for small environments:

```
connection_limit=5&pool_timeout=10
```

## Next Steps

