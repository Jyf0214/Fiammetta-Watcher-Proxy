# Quick Start

## Local Development

### 1. Install Dependencies

```bash
git clone -b canary https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
npm install --legacy-peer-deps
```

### 2. Configure Admin Credentials

**No database setup is needed for local development**: `npm run dev` starts an embedded PostgreSQL (data in `.pgdata/`) and writes `.env.local` (`DB_TYPE=pg` + `DB_PUSH=1`; prepare-db reads `.env.local` first). Just configure admin login:

```bash
cat > .env << 'EOF'
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password
JWT_SECRET=random-secret-32+chars
EOF
```

### 3. Start the Dev Server

```bash
npm run dev
```

`npm install` / `npm run dev` auto-generate the Prisma Client and **automatically sync the schema to the local embedded PostgreSQL** (the predev hook runs `dev-postgres.mjs --ensure` + `prepare-db.mjs`) — no manual table setup.

### 4. Access the Admin Panel

Open `http://localhost:3000/admin` and log in with your admin credentials.

## Deploy to Production

FWP supports multiple deployment options: Cloudflare, Vercel, EdgeOne, Node.js, and Docker. See the [Deployment Guide](/en/deployment/) for the full tutorial and platform comparison, and the per-platform docs:

- [Cloudflare](/en/deployment/cloudflare)
- [Vercel](/en/deployment/vercel)
- [EdgeOne](/en/deployment/edgeone)
- [Node.js standalone](/en/deployment/standalone)
- [Docker](/en/deployment/docker)

## Next Steps

- [Platform Config](/en/guide/platform) — Configure upstream AI service providers
- [API Key Management](/en/guide/api-key) — Create and manage API keys
- [Model Mapping](/en/guide/model-map) — Configure model name mappings
- [API Reference](/en/api/) — endpoint usage
- [Environment Variables](/en/deployment/env) — Complete env var reference
