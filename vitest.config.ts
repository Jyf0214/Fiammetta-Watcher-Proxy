import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// 测试环境加载 .env.local（本地开发 PostgreSQL 配置），供 createDb() 动态解析数据库类型与连接串。
// 注意：加载后 DATABASE_URL 会进入所有测试 worker 的 process.env——测试文件必须显式
// 传 env（如 createTestDb 的 PG_URL）或先建立缓存，禁止无参 createDb() 直接读写开发库。
function loadEnvLocal() {
  const envFile = resolve(__dirname, ".env.local");
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvLocal();

export default defineConfig({
  resolve: {
    alias: {
      // 与 tsconfig paths（@/* -> ./src/*）一致，让测试能直接 import 生产模块（@/lib/... 等）
      "@": resolve(__dirname, "src"),
    },
  },
  plugins: [
    {
      // Prisma 7 runtime="cloudflare" 生成的 d1 client 用 webpack 语法 import wasm（"?module" 后缀，
      // default 导出为 WebAssembly.Module）；vite/vitest 不识别该语法，这里按等价语义提供模块
      name: "wasm-module-shim",
      load(id) {
        if (!id.endsWith(".wasm?module")) return;
        const base64 = readFileSync(id.replace(/\?module$/, "")).toString("base64");
        return `const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0)); export default new WebAssembly.Module(bytes);`;
      },
    },
  ],
});