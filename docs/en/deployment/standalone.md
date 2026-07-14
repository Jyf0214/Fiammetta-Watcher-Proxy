# Node.js Standalone Deployment

This guide covers deploying FWP without Docker, running directly with Node.js.

## Requirements

| Dependency | Minimum | Recommended |
|------------|---------|-------------|
| Node.js | 18.0 | 22.x LTS |
| npm | 8.0 | 10.x |
| Database (one of) | MySQL 5.7 / PostgreSQL 14 | MySQL 8.0 / PostgreSQL 16 |

::: tip
Node.js 22 LTS is recommended — the same version used in the project's Dockerfile (`node:22-alpine`).
:::

## Step 1: Clone the Project

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
git checkout main
```

## Step 2: Install Dependencies

```bash
npm install
```

The `postinstall` script automatically generates the Prisma Client.

## Step 3: Prepare the Database

FWP uses Prisma ORM and supports both **PostgreSQL** and **MySQL**.

### PostgreSQL

```bash
createdb fwp
# Connection string format:
# postgresql://user:password@host:port/dbname?connection_limit=5&pool_timeout=10
```

### MySQL

```bash
mysql -u root -e "CREATE DATABASE fwp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
# Connection string format:
# mysql://user:password@host:port/dbname?connection_limit=5&pool_timeout=10
```

### TiDB Cloud

```env
DATABASE_URL=mysql://user:password@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?connection_limit=5&pool_timeout=10&sslaccept=accept_invalid_certs
```

::: warning
TiDB Cloud requires `sslaccept=accept_invalid_certs` in the connection string due to self-signed certificates.
:::

## Step 4: Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with the required settings:

```env
# Database connection string (required)
DATABASE_URL=postgresql://user:password@localhost:5432/fwp

# JWT secret (required, at least 32 random bytes)
# Generate with: openssl rand -base64 32
JWT_SECRET=your-super-secret-key

# Admin account (required)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-admin-password

# Server port (optional, default 3000)
PORT=3000
```

::: warning
Generate `JWT_SECRET` with `openssl rand -base64 32` — do not use simple strings.
:::

## Step 5: Database Migration

### PostgreSQL Users

The default `prisma/schema.prisma` uses MySQL as the provider. PostgreSQL users need to change it first:

```bash
sed -i 's/provider = "mysql"/provider = "postgresql"/' prisma/schema.prisma
npx prisma db push
```

### MySQL Users

```bash
npx prisma db push
```

::: tip
`prisma db push` automatically creates or updates database tables. First run creates all tables; subsequent runs apply incremental changes.
:::

## Step 6: Initialize Admin

FWP automatically creates the admin account from `ADMIN_USERNAME` and `ADMIN_PASSWORD` environment variables on startup. No manual steps needed.

- If no admin exists in the database, one is created from env vars
- If an admin already exists, creation is skipped
- Passwords are hashed with PBKDF2-SHA256 (600,000 iterations)

## Step 7: Start the Service

### Development Mode

```bash
npm run dev
```

Hot reload enabled, defaults to `http://localhost:3000`.

### Production Mode

```bash
npm run build
npm start
```

Uses Next.js standalone output for better performance.

## Step 8: Access the Admin Panel

Visit in your browser:

```
http://localhost:3000/admin
```

Log in with the credentials configured in Step 4.

## First-Time Setup Wizard

If `DATABASE_URL` is not configured at startup, the system redirects to the `/setup` page where you can configure the database and admin account through the web interface. This is useful for quick trials without preparing a database in advance.

## Troubleshooting

### Database Connection Failed

**Error**: `P1001: Can't reach database server`

1. Verify the database service is running
2. Check host, port, username, and password in `DATABASE_URL`
3. Ensure the database allows remote connections (check MySQL `bind-address`)
4. Check firewall rules for the database port

### Port Already in Use

**Error**: `EADDRINUSE: address already in use :::3000`

```bash
lsof -i :3000
PORT=3001 npm start
```

### Prisma Client Not Generated

```bash
npx prisma generate
```

### Permission Denied

Ensure the database user has these permissions:
- PostgreSQL: `CREATE`, `ALTER`, `DROP`
- MySQL: `CREATE`, `ALTER`, `DROP`, `INSERT`, `UPDATE`, `SELECT`

### Admin Login Failed

1. Verify `ADMIN_USERNAME` and `ADMIN_PASSWORD` env vars are set correctly
2. Verify `JWT_SECRET` is set (missing it causes Token signing failure)
3. Check logs for `[致命错误] 缺少必需环境变量` messages

### Memory Optimization

For environments with less than 1GB RAM, add connection pool parameters to `DATABASE_URL`:

```
?connection_limit=5&pool_timeout=10
```
