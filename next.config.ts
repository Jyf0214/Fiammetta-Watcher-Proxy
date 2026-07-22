import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloudflare Pages 不支持图片优化
  images: {
    unoptimized: true,
  },
  // 生产环境禁用源码映射，防止源码泄露
  productionBrowserSourceMaps: false,
  // Lobe UI 需要转译
  transpilePackages: ["@lobehub/ui"],
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
