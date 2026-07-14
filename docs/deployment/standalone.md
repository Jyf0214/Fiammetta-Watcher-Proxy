# Node.js 直接部署（非 Docker）

本指南介绍如何在不使用 Docker 的情况下，通过 Node.js 直接运行 FWP。

## 环境要求

| 依赖 | 最低版本 | 推荐版本 |
|------|----------|----------|
| Node.js | 18.0 | 22.x LTS |
| npm | 8.0 | 10.x |
| 数据库（二选一） | MySQL 5.7 / PostgreSQL 14 | MySQL 8.0 / PostgreSQL 16 |

::: tip
推荐使用 Node.js 22 LTS，项目 Dockerfile 中使用的就是 `node:22-alpine`。
:::

## 第一步：克隆项目

```bash
git clone https://github.com/Jyf0214/Fiammetta-Watcher-Proxy.git
cd Fiammetta-Watcher-Proxy
git checkout main
```

## 第二步：安装依赖

```bash
npm install
```

`npm install` 会自动执行 `postinstall` 脚本，生成 Prisma Client。

## 第三步：准备数据库

FWP 通过 Prisma ORM 支持 **PostgreSQL** 和 **MySQL** 两种数据库。

### PostgreSQL

```bash
# 创建数据库
createdb fwp

# 连接字符串格式
# postgresql://用户名:密码@主机:端口/数据库名?connection_limit=5&pool_timeout=10
```

### MySQL

```bash
# 创建数据库
mysql -u root -e "CREATE DATABASE fwp CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 连接字符串格式
# mysql://用户名:密码@主机:端口/数据库名?connection_limit=5&pool_timeout=10
```

### TiDB Cloud

FWP 同样兼容 TiDB Cloud（MySQL 兼容模式）：

```env
DATABASE_URL=mysql://用户名:密码@gateway01.xxxx.prod.aws.tidbcloud.com:4000/dbname?connection_limit=5&pool_timeout=10&sslaccept=accept_invalid_certs
```

::: warning
连接 TiDB Cloud 时需要添加 `sslaccept=accept_invalid_certs` 参数，因为 TiDB Cloud 默认使用自签名证书。
:::

## 第四步：配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填写以下必需配置：

```env
# 数据库连接字符串（必须）
DATABASE_URL=postgresql://user:password@localhost:5432/fwp

# JWT 密钥（必须，至少 32 字节随机字符串）
# 生成方式：openssl rand -base64 32
JWT_SECRET=your-super-secret-key

# 管理员账号（必须）
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-admin-password

# 服务端口（可选，默认 3000）
PORT=3000
```

::: warning
`JWT_SECRET` 建议使用 `openssl rand -base64 32` 生成随机密钥，切勿使用简单字符串。
:::

## 第五步：数据库迁移

根据你的数据库类型选择对应命令。

### PostgreSQL 用户

FWP 的 `prisma/schema.prisma` 默认 `provider` 为 MySQL。PostgreSQL 用户需要在迁移前修改 provider：

```bash
# 修改 schema 中的 provider
sed -i 's/provider = "mysql"/provider = "postgresql"/' prisma/schema.prisma

# 推送数据库结构
npx prisma db push
```

### MySQL 用户

直接执行迁移即可（MySQL 是默认 provider）：

```bash
npx prisma db push
```

::: tip
`prisma db push` 会自动根据 schema 创建或更新数据库表结构。首次执行会创建所有表，后续执行会增量更新。
:::

## 第六步：初始化管理员

启动应用时，FWP 会自动根据 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 环境变量创建管理员账户。无需手动执行额外命令。

管理员初始化逻辑：
1. 如果数据库中没有管理员账户，则从环境变量自动创建
2. 如果管理员已存在，则跳过创建
3. 密码使用 PBKDF2-SHA256（600000 次迭代）哈希存储

## 第七步：启动服务

### 开发模式

```bash
npm run dev
```

开发模式下支持热更新，默认监听 `http://localhost:3000`。

### 生产模式

```bash
# 构建
npm run build

# 启动
npm start
```

生产模式使用 Next.js standalone 输出，性能更优。

## 第八步：访问管理后台

打开浏览器访问：

```
http://localhost:3000/admin
```

使用第四步配置的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 登录。

## 首次配置向导

如果启动时未配置 `DATABASE_URL`，系统会自动引导到 `/setup` 页面，在网页上完成数据库和管理员的配置。这种模式适合快速试用，无需提前准备数据库。

## 常见问题排查

### 数据库连接失败

**错误信息**: `P1001: Can't reach database server`

排查步骤：
1. 确认数据库服务已启动
2. 检查 `DATABASE_URL` 中的主机、端口、用户名、密码是否正确
3. 检查数据库是否允许远程连接（MySQL 需检查 `bind-address`）
4. 检查防火墙是否放行了数据库端口

### 端口被占用

**错误信息**: `EADDRINUSE: address already in use :::3000`

解决方法：

```bash
# 查找占用端口的进程
lsof -i :3000

# 改用其他端口
PORT=3001 npm start
```

### Prisma Client 未生成

**错误信息**: `PrismaClient is not generated`

解决方法：

```bash
npx prisma generate
```

### 权限不足

确保数据库用户拥有以下权限：
- PostgreSQL：`CREATE`, `ALTER`, `DROP`（建表/改表所需）
- MySQL：`CREATE`, `ALTER`, `DROP`, `INSERT`, `UPDATE`, `SELECT`

### 管理员登录失败

排查步骤：
1. 确认 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 环境变量已正确设置
2. 确认 `JWT_SECRET` 已设置（未设置会导致 Token 签名失败）
3. 检查日志中是否有 `[致命错误] 缺少必需环境变量` 提示

### 数据库内存优化

在内存小于 1GB 的环境中，建议在 `DATABASE_URL` 末尾添加连接池参数：

```
?connection_limit=5&pool_timeout=10
```
