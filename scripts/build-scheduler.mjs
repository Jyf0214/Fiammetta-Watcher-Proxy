/**
 * build-scheduler.mjs — 打包 Docker 内部定时调度器为独立进程产物
 *
 * 背景：instrumentation.ts 曾作为调度器入口，但 Next.js 的 instrumentation
 * 会被 OpenNext 编入 Cloudflare Edge Worker，把调度器静态依赖链（undici、
 * 四个定时任务模块等）全部打进 Pages Function，导致 Worker 体积超过
 * 免费计划 3 MiB 限制、Pages 部署持续失败（2026-08-18 实测根因）。
 *
 * 方案：调度器改为 Docker 容器内的独立 Node 进程（由 docker-entrypoint
 * 启动 .build/scheduler.cjs），完全脱离 Next.js 构建产物；Cloudflare
 * Edge Worker 不再包含调度器链。
 *
 * 产物要求（Docker runner 阶段生产依赖需包含以下 external 包）：
 *   - undici / fetch-socks：出站代理栈，动态 import 惰性加载，仅配置代理时触发
 *   - @opennextjs/cloudflare：createDb 无参时的 Pages 环境检测；独立进程始终
 *     传 env 参数（DOCKER_TASKS 固定传 { DB_TYPE, DB }），不会走到该分支
 *   - @prisma/*、@tidbcloud/prisma-adapter、pg：数据库适配层，运行时解析
 *   - Prisma 方言 client 生成物（src/generated/*）与查询编译器 wasm 在打包时
 *     内联进 bundle（wasm 经自定义插件 base64 内联为 WebAssembly.Module），
 *     运行时无需 src/generated 文件（构建前 prepare-db.mjs 需先完成生成）
 *
 * 使用方式：
 *   node scripts/build-scheduler.mjs
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, ".build", "scheduler.cjs");

// Prisma 7 生成的 client 用 webpack 的 wasm 模块语义加载查询编译器
// （import("./xxx.wasm?module") 返回 { default: WebAssembly.Module }）。
// esbuild 无此 loader，用插件把 wasm 以 base64 内联并在加载时编译为 Module，
// 与 Next.js 构建产物的运行时语义一致（仅编译不实例化，无环境依赖）。
const prismaWasmPlugin = {
  name: "prisma-wasm-module",
  setup(build) {
    build.onResolve({ filter: /\.wasm\?module$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?module$/, "")),
      namespace: "prisma-wasm",
    }));
    build.onLoad({ filter: /.*/, namespace: "prisma-wasm" }, (args) => {
      const base64 = readFileSync(args.path).toString("base64");
      return {
        contents: `const bytes = Uint8Array.from(atob("${base64}"), (c) => c.charCodeAt(0));
const module = new WebAssembly.Module(bytes);
export default module;`,
        loader: "js",
      };
    });
  },
};

// 入口包装：scheduler.ts 只导出不自动启动，独立进程需要显式调用 startScheduler()
const ENTRY_SOURCE = `
import { startScheduler } from "./src/lib/scheduler";
startScheduler();
`;

await build({
  stdin: {
    contents: ENTRY_SOURCE,
    resolveDir: ROOT,
    sourcefile: "scheduler-entry.ts",
  },
  plugins: [prismaWasmPlugin],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: OUT,
  // tsconfig paths：@/* → ./src/*（与 Next.js 构建一致）
  tsconfig: resolve(ROOT, "tsconfig.json"),
  external: [
    "undici",
    "fetch-socks",
    "@opennextjs/cloudflare",
    "@prisma/client",
    // pg client 的查询编译器：base64 wasm 已内联于包内 JS，保持 external 由运行时解析
    "@prisma/client/runtime/wasm-compiler-edge",
    "@prisma/adapter-d1",
    "@prisma/adapter-mariadb",
    "@prisma/adapter-pg",
    "@tidbcloud/prisma-adapter",
    "pg",
  ],
  logLevel: "info",
});

console.log(`✓ 调度器独立进程产物已生成: ${OUT}`);
