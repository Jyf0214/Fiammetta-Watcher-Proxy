/**
 * 扩展 OpenNext 的 CloudflareEnv 全局接口
 * 添加本项目自定义的 Cloudflare 绑定类型
 */
declare global {
  interface CloudflareEnv {
    DB?: D1Database;
    KV?: KVNamespace;
  }
}

export {};
