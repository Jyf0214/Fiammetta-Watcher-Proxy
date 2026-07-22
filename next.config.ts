import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloudflare Pages 兼容配置
  // 关闭图片优化（Cloudflare Pages 不支持 Next.js Image 优化）
  images: {
    unoptimized: true,
  },
};

export default nextConfig;

// 本地开发时如需 Cloudflare Bindings，取消下方注释：
// import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
// initOpenNextCloudflareForDev();
