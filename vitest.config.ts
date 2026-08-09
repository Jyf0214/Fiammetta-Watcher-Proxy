import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

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