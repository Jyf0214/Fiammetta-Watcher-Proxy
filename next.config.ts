import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
    // 性能优化
    optimizeCss: true,                    // CSS 优化，减少 CSS 包大小
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
