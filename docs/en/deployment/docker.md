# Docker Deployment

## Using Docker Compose

### 1. Clone the repository

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

### 3. Start services

```bash
docker compose up -d
```

### 4. View logs

```bash
docker compose logs -f
```

### 5. Stop services

```bash
docker compose down
```

## Docker Compose Configuration

The default `docker-compose.yml` includes:

- **app** — FWP application service
- **db** — PostgreSQL database

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://fwp:password@db:5432/fwp
      - JWT_SECRET=your-secret-key
    depends_on:
      - db

  db:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=fwp
      - POSTGRES_USER=fwp
      - POSTGRES_PASSWORD=password
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

## Standalone Docker

```bash
docker build -t fwp .
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/fwp \
  -e JWT_SECRET=your-secret \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=your-password \
  fwp
```

## Next Steps

