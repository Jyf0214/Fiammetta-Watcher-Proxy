/**
 * Cloudflare Workers 环境变量绑定类型
 *
 * 定义 D1 数据库、KV 命名空间和自定义环境变量的类型。
 * 在 wrangler.toml 中绑定，在 Worker 代码中通过 env 参数访问。
 */

import type { D1Database } from "@cloudflare/workers-types";
import type { KVNamespace } from "@cloudflare/workers-types";

export interface Env {
  // Cloudflare 服务绑定
  DB: D1Database;
  KV: KVNamespace;

  // 环境变量（通过 wrangler.toml [vars] 或 Dashboard 设置）
  ENVIRONMENT: string;

  // 敏感配置（必须通过 Cloudflare Dashboard 设置，不要写入代码）
  JWT_SECRET?: string;
  JWKS_KEY?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}
