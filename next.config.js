/** @type {import('next').NextConfig} */
const nextConfig = {
  // Cloudflare Pages 兼容配置
  // 关闭图片优化（Cloudflare Pages 不支持 Next.js Image 优化）
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
