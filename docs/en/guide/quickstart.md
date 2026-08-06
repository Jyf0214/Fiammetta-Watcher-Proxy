# Quick Start

## Local Development

### 1. Install Dependencies

```bash
git clone -b canary https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
npm install --legacy-peer-deps
```

### 2. Configure Environment Variables

```bash
cat > .env << 'EOF'
DB_TYPE=tidb
DATABASE_URL=mysql://user:password@host:4000/dbname?sslaccept=accept_invalid_certs
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password
JWT_SECRET=random-secret-32+chars
EOF
```

### 3. Initialize the Database

```bash
DB_PUSH=1 node scripts/prepare-db.mjs
```

`npm install` / `npm run dev` auto-generate the Prisma Client, but **the table schema is NOT pushed by default locally** (to protect real databases from accidental changes). On first setup, run the command above to sync the schema to the database in `DATABASE_URL` (`DB_TYPE` is inferred from the `DATABASE_URL` protocol).

### 4. Start the Dev Server

```bash
npm run dev
```

### 5. Access the Admin Panel

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
- [Environment Variables](/en/deployment/env) — Complete env var reference
