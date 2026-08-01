import type { NextConfig } from "next";
import { resolve } from "path";

/** 按 DB_TYPE 只生成一个方言的 Prisma Client，其他方言用空 stub 代替 */
function getPrismaAlias() {
  const dbType = process.env.DB_TYPE || "d1";
  const dialects = ["d1", "mysql", "mariadb", "pg"];
  const alias: Record<string, string> = {};
  for (const d of dialects) {
    // 跳过实际使用的方言：tidb 使用 mysql 目录，hyperdrive 使用 pg 目录
    if (d === dbType) continue;
    if (dbType === "tidb" && d === "mysql") continue;
    if (dbType === "hyperdrive" && d === "pg") continue;
    alias[`../src/generated/${d}/client`] = resolve(__dirname, "scripts/empty-client.ts");
  }
  return alias;
}

// Cloudflare Pages 构建（opennextjs-cloudflare）按 workerd 条件解析 external 包：
// @prisma/client 的 WASM 引擎、pg-cloudflare 的真实 Socket 实现都能正确打包。
// 非 CF 平台（EdgeOne/Vercel/纯 Node）没有该打包器，Turbopack external 化后运行时
// import("<包名>-<hash>") 依赖 .next/node_modules symlink，上传部署时 symlink 丢失
// → ERR_MODULE_NOT_FOUND（@prisma/client 是所有方言必经模块）。
// 因此数据库栈在 CF 构建保持 external（恢复已验证行为），非 CF 构建强制转译内联。
const isCFDeploy = process.env.DEPLOY_PLATFORM === "cf";

// CF 平台可用的数据库栈（d1/tidb/pg/hyperdrive）——CF 构建保持 external，
// 由 opennextjs-cloudflare 按 workerd 条件打包。
const prismaStack = [
  "@prisma/client",
  ".prisma/client",
  "@prisma/adapter-d1",
  "@prisma/adapter-pg",
  "@tidbcloud/prisma-adapter",
  "pg",
];

// MariaDB/纯 MySQL（mariadb 驱动，TCP）仅支持非 CF 平台：
// - 非 CF 构建强制转译内联（EdgeOne/纯 Node 可运行）
// - CF 构建通过 turbopack.resolveAlias 指向空 stub，不打包 TCP 驱动（体积 + workerd 兼容）
const mariadbStack = ["@prisma/adapter-mariadb", "mariadb"];

const nextConfig: NextConfig = {
  // Cloudflare Pages 不支持图片优化
  images: {
    unoptimized: true,
  },
  // 生产环境禁用源码映射，防止源码泄露
  productionBrowserSourceMaps: false,
  // 临时跳过 TypeScript 类型检查（迁移期间）
  typescript: {
    ignoreBuildErrors: true,
  },
  // 安全响应头
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          { key: "X-XSS-Protection", value: "0" },
        ],
      },
    ];
  },
  // Turbopack（Next.js 16 默认）：未使用的方言由 prepare-db.mjs 生成的 stub 文件自动解析；
  // CF 构建时 mariadb（TCP 驱动）alias 到空 stub（CF 不支持 mariadb）。
  // 注意 resolveAlias 值为字符串，本地文件用相对项目根的路径（绝对路径会被当成 relative import）。
  turbopack: {
    ...(isCFDeploy
      ? {
          resolveAlias: {
            mariadb: "./scripts/empty-mariadb.ts",
            "@prisma/adapter-mariadb": "./scripts/empty-mariadb.ts",
          },
        }
      : {}),
  },
  // Turbopack（Next.js 16 默认）会把部分包 external 化并在运行时 import("<包名>-<hash>")，
  // 该 ID 依赖 .next/node_modules symlink 解析，EdgeOne 上传部署时 symlink 丢失 → 500。
  // 通用库无条件内联（CF 侧内联无副作用）；数据库栈仅非 CF 内联（见 prismaStack 注释）。
  transpilePackages: [
    "i18next",
    "react-i18next",
    "i18next-browser-languagedetector",
    "jose",
    "clsx",
    "motion",
    "tailwind-merge",
    ...(isCFDeploy ? [] : [...prismaStack, ...mariadbStack]),
  ],
  // Webpack（--webpack 模式）：alias 未使用的方言到空 stub
  webpack: (config) => {
    const alias = getPrismaAlias();
    if (Object.keys(alias).length > 0) {
      config.resolve = config.resolve || {};
      config.resolve.alias = { ...config.resolve.alias, ...alias };
    }
    return config;
  },
  // mysql2 为 prisma CLI 依赖（构建期 db push 用），运行时无 import；
  // pg-cloudflare 由 pg 内部按 workerd 条件引用，非 workerd 环境解析为空模块。
  // CF 构建额外将数据库栈保持 external，由 opennextjs-cloudflare 按 workerd 条件打包。
  serverExternalPackages: [
    "mysql2",
    "pg-cloudflare",
    ...(isCFDeploy ? prismaStack : []),
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
    // 性能优化
    webpackBuildWorker: true,             // 独立进程构建，优化内存
    parallelServerCompiles: true,         // 并行编译服务端代码
    parallelServerBuildTraces: true,      // 并行收集构建追踪
    workerThreads: true,                  // 使用 Worker 线程提升性能
    memoryBasedWorkersCount: true,        // 根据内存动态调整 Worker 数量
    serverMinification: true,             // 服务端代码压缩
    optimizeServerReact: true,            // React 服务端优化
  },
};

export default nextConfig;
