# Quick Start

## Option 1: Cloudflare Deployment (Recommended)

The simplest deployment method — zero operational cost, global edge nodes.

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free)
- [GitHub account](https://github.com)

### Steps

1. Fork the project to your GitHub account
2. Get a [Cloudflare API Token](https://dash.cloudflare.com/profile/api-tokens) (permissions: Workers Edit, D1 Edit, Pages Edit)
3. Run the initialization script:

```bash
git clone https://github.com/your-username/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
pip install -r deploy/requirements.txt
export CLOUDFLARE_API_TOKEN="your-token"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
python deploy/init.py
```

4. Add the IDs from `init.py` output to GitHub repo Settings → Secrets
5. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` in Cloudflare Dashboard → Worker → Settings → Variables
6. Push to `main` branch — auto-deploys

See [Cloudflare Deployment](/en/deployment/cloudflare) for details.

## Option 2: Local Development

### 1. Install Dependencies

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
npm install
```

### 2. Configure Environment Variables

```bash
cat > .env << 'EOF'
DB_TYPE=tidb
DATABASE_URL=mysql://user:password@host:4000/dbname?sslaccept=accept_invalid_certs
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-password
JWT_SECRET=
EOF
```

### 3. Initialize Database

```bash
node scripts/prepare-db.mjs
```

### 4. Start Dev Server

```bash
npm run dev
```

### 5. Access Admin Panel

Open `http://localhost:3000/admin` and log in with your admin credentials.

## Option 3: Vercel Deployment

1. Import the GitHub repository in [Vercel Dashboard](https://vercel.com/dashboard)
2. Framework preset: Next.js
3. Add environment variables (`DB_TYPE`, `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`)
4. Deploy

See [Vercel Deployment](/en/deployment/vercel) for details.

## Option 4: Node.js Standalone

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
git checkout feat/cloudflare-workers
npm install
# Configure .env file (see Option 2)
node scripts/prepare-db.mjs
npm run build
npm start
```

See [Node.js Standalone](/en/deployment/standalone) for details.

## Next Steps

- [Platform Config](/en/guide/platform) — Configure upstream AI service providers
- [API Key Management](/en/guide/api-key) — Create and manage API keys
- [Model Mapping](/en/guide/model-map) — Configure model name mappings
- [Environment Variables](/en/deployment/env) — Complete env var reference
