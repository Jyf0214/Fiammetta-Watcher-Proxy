/**
 * build-register-device.mjs — 打包 Docker 启动期设备注册为独立进程产物
 *
 * 模式与 scripts/build-scheduler.mjs 一致：esbuild 打 .cjs 产物，内联 Prisma
 * 方言 client 与查询编译器 wasm。Docker entrypoint 在容器启动时调一次：
 *   - 命中既有 deviceName → 复用 UUID + 累加 bootCount + 刷新 lastSeenAt
 *   - 未命中 → 插入新行（新 UUID + 平台 + 首次注册时间）
 *
 * 行为契约（与 src/lib/device-registration.registerDevice 一致）：
 *   - 注册失败仅记日志，进程退出码仍为 0（不阻塞容器启动）
 *   - DEPLOY_PLATFORM !== "docker" 时 registerDevice 内部不调 createDb；
 *     本脚本无论部署平台都打包，CF 部署不会运行（不会构建 Docker 镜像）
 *
 * 产物要求（Docker runner 阶段生产依赖需包含以下 external 包）：
 *   - 与 build-scheduler.mjs 一致：undici / fetch-socks / @opennextjs/cloudflare
 *     / @prisma/* / pg / mariadb 等运行时由 process.env 决定连接的数据库栈
 *
 * 使用方式：
 *   node scripts/build-register-device.mjs
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT = resolve(ROOT, ".build", "register-device.cjs");

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

// 入口包装：registerDevice 是单飞函数，import 后立刻调用一次即可。
const ENTRY_SOURCE = `
import { registerDevice } from "./src/lib/device-registration";

(async () => {
  // 容器内本机 IP 取不到时 address 传 null（与管理后台可见 null 一致）。
  // entrypoint 在容器内已限制 V8 堆 192MB，与定时器进程共用同一上限。
  const result = await registerDevice(null);
  // 失败已在内部记日志；此处仅打一行汇总便于排障
  if (result.registered) {
    console.log(\`[register-device] device=\${result.deviceName} uuid=\${result.uuid}\`);
  } else {
    console.log("[register-device] 跳过注册（详见日志）");
  }
  // 无论成功失败都正常退出——注册失败不应阻塞容器启动
  process.exit(0);
})().catch((err) => {
  console.error("[register-device] 未捕获异常:", err);
  process.exit(0);
});
`;

await build({
  stdin: {
    contents: ENTRY_SOURCE,
    resolveDir: ROOT,
    sourcefile: "register-device-entry.ts",
  },
  plugins: [prismaWasmPlugin],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: OUT,
  tsconfig: resolve(ROOT, "tsconfig.json"),
  external: [
    "undici",
    "fetch-socks",
    "@opennextjs/cloudflare",
    "@prisma/client",
    "@prisma/client/runtime/wasm-compiler-edge",
    "@prisma/adapter-d1",
    "@prisma/adapter-mariadb",
    "@prisma/adapter-pg",
    "@tidbcloud/prisma-adapter",
    "pg",
  ],
  logLevel: "info",
});

console.log(`✓ 设备注册独立进程产物已生成: ${OUT}`);