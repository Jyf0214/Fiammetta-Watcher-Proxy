import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// 仅 Cloudflare 平台（DEPLOY_PLATFORM=cf 或未设置，含本地 Cloudflare 开发）使用 Cloudflare 专用 OpenNext 配置。
// EdgeOne/Vercel 等非 Cloudflare 平台不引入 Cloudflare 构建包，由平台自身的构建器/适配器提供默认配置，
// 避免 Cloudflare 专用 external 模块在非 Cloudflare 运行时无法加载。
const isCfPlatform =
  process.env.DEPLOY_PLATFORM !== "edgeone" &&
  process.env.DEPLOY_PLATFORM !== "vercel";

export default isCfPlatform ? defineCloudflareConfig({}) : {};
