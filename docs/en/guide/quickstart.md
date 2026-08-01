# Quick Start

## Option 1: Cloudflare Deployment (Recommended)

The simplest deployment method — zero operational cost, global edge nodes.

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- [GitHub account](https://github.com)

### Steps

1. Fork the project to your GitHub account
2. Get a [Cloudflare API Token](https://dash.cloudflare.com/profile/api-tokens) (permissions: Workers Edit, Workers KV Storage Edit, D1 Edit, Pages Edit)
3. In repo Settings → Secrets and variables → Actions, add these secrets:

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Your Cloudflare API Token |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare Account ID (right sidebar in the Dashboard) |
| `ADMIN_USERNAME` | Admin panel login username |
| `ADMIN_PASSWORD` | Admin panel login password |
| `DB_TYPE` | Database type, default `d1` — no database to provision |
| `DATABASE_URL` | External database connection string (only needed when `DB_TYPE=tidb/pg`) |

4. In the Actions tab, enable the workflow (approve the first run if prompted)
5. Run the workflow manually: Actions → Deploy → Run workflow → branch `canary` → platform `cf` → Run workflow. Deployment completes automatically (database, Worker, Pages, and admin credentials are all configured for you)

See [Cloudflare Deployment](/en/deployment/cloudflare) for details.

## Option 2: Local Development

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

## Option 3: Vercel Deployment

1. Import the GitHub repository in [Vercel Dashboard](https://vercel.com/dashboard)
2. Framework preset: Next.js
3. Add environment variables (`DB_TYPE`, `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`)
4. Deploy

See [Vercel Deployment](/en/deployment/vercel) for details.

## Option 4: Node.js Standalone

```bash
git clone -b canary https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
npm install --legacy-peer-deps
# Configure the .env file (see Option 2)
npm run build
npx next start
```

See [Node.js Standalone](/en/deployment/standalone) for details.

## Next Steps

- [Platform Config](/en/guide/platform) — Configure upstream AI service providers
- [API Key Management](/en/guide/api-key) — Create and manage API keys
- [Model Mapping](/en/guide/model-map) — Configure model name mappings
- [Environment Variables](/en/deployment/env) — Complete env var reference
