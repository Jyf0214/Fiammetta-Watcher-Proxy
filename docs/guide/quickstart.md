# 快速开始

## 环境要求

- Node.js 18+
- PostgreSQL 或 MySQL
- Docker（推荐）

## Docker 部署（推荐）

### 1. 克隆项目

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填写必要的配置：

```env
# 数据库
DATABASE_URL=postgresql://user:password@localhost:5432/fwp

# JWT 密钥（必须修改）
JWT_SECRET=your-super-secret-key

# 管理员账号
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-admin-password
```

### 3. 启动服务

```bash
docker compose up -d
```

### 4. 访问管理后台

打开浏览器访问 `http://localhost:3000/admin`，使用配置的管理员账号登录。

## 本地开发

### 1. 安装依赖

```bash
npm install
```

### 2. 初始化数据库

```bash
npx prisma db push
```

### 3. 启动开发服务器

```bash
npm run dev
```

## 下一步

