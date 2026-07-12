# Quick Start

## Requirements

- Node.js 18+
- PostgreSQL or MySQL
- Docker (recommended)

## Docker Deployment (Recommended)

### 1. Clone the repository

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` with required configuration:

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/fwp

# JWT Secret (must change)
JWT_SECRET=your-super-secret-key

# Admin account
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-admin-password
```

### 3. Start services

```bash
docker compose up -d
```

### 4. Access admin panel

Open `http://localhost:3000/admin` and login with your admin credentials.

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Initialize database

```bash
npx prisma db push
```

### 3. Start dev server

```bash
npm run dev
```

## Next Steps

- [Platform Config](/en/guide/platform) — Add your first AI platform
- [Environment](/en/deployment/env) — All configuration options
