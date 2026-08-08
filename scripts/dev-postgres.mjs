#!/usr/bin/env node
/**
 * 开发环境嵌入式 PostgreSQL 快速启动脚本
 *
 * 开发时无需手动安装/启动 PostgreSQL：本脚本用 embedded-postgres 包管理
 * 一个落在项目目录 .pgdata/ 的嵌入式 PG 实例（数据文件化，无系统服务依赖）。
 *
 * 用法：
 *   npm run db:dev              # 前台启动：初始化（如需）+ 启动 + 建库 + 写 .env.local
 *   npm run db:dev -- --stop    # 停止
 *   npm run db:dev -- --status  # 查看运行状态
 *   npm run db:dev -- --ensure  # predev 钩子用：已运行则跳过，否则后台拉起（非阻塞）
 *
 * 连接信息（固定，显式写入 .env.local，不修改任何代码默认值）：
 *   DB_TYPE=pg
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/fiammetta_dev
 *   DB_PUSH=1（本地开发自动同步表结构）
 *   .env.local 会被 scripts/prepare-db.mjs 优先读取（高于 .env）；
 *   .env.local 仅存在于本地，不会进入 CI/部署（部署仍走代码默认 d1）
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_LOCAL = resolve(ROOT, ".env.local");
const DB_DIR = resolve(ROOT, ".pgdata");
const LOG_FILE = resolve(DB_DIR, "dev-db.log");
const PORT = 55432;
const USER = "postgres";
const PASSWORD = "postgres";
const APP_DB = "fiammetta_dev";
const PG_URL = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${APP_DB}`;

/** TCP 探活：端口是否已被 PG 监听 */
function probePort(timeoutMs = 800) {
  return new Promise((done) => {
    const sock = net.connect(PORT, "127.0.0.1");
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => {
      sock.destroy();
      done(true);
    });
    sock.once("error", () => done(false));
    sock.once("timeout", () => {
      sock.destroy();
      done(false);
    });
  });
}

/** 等待端口就绪（服务启动等待，非测试等待） */
async function waitForPort(totalMs = 180_000) {
  const started = Date.now();
  while (Date.now() - started < totalMs) {
    if (await probePort()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** 幂等写入 .env.local（显式指定 DB_TYPE=pg + DATABASE_URL + 本地自动 db push） */
function writeEnvLocal() {
  const existing = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, "utf8") : "";
  const lines = existing
    .split("\n")
    .filter(
      (l) =>
        l.trim() &&
        !l.trim().startsWith("#") &&
        !l.startsWith("DB_TYPE=") &&
        !l.startsWith("DATABASE_URL=") &&
        !l.startsWith("DB_PUSH=")
    );
  lines.push(`DB_TYPE=pg`);
  lines.push(`DATABASE_URL=${PG_URL}`);
  // 本地开发库表结构随 predev 自动同步（prepare-db.mjs 据此执行 db push）
  lines.push("DB_PUSH=1");
  writeFileSync(ENV_LOCAL, lines.join("\n") + "\n");
}

/** server 模式：初始化 + 启动 + 建库 + 保持进程存活（前台/后台子进程均走此路径） */
async function runServer() {
  const pg = new EmbeddedPostgres({
    databaseDir: DB_DIR,
    port: PORT,
    user: USER,
    password: PASSWORD,
    persistent: true,
  });
  if (!existsSync(DB_DIR)) {
    console.log(
      "[dev-db] 首次初始化嵌入式 PostgreSQL（下载二进制 + initdb，约 1-2 分钟）..."
    );
  }
  await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase(APP_DB);
    console.log(`[dev-db] 数据库 ${APP_DB} 已创建`);
  } catch (err) {
    // 库已存在时 createDatabase 报 duplicate database，属正常
    const msg = String(err?.message ?? err);
    if (!/already exists|duplicate database/i.test(msg)) throw err;
  }
  writeEnvLocal();
  console.log(`[dev-db] 嵌入式 PostgreSQL 已就绪: ${PG_URL}`);
  // 保持进程存活（embedded-postgres 退出钩子会随进程清理 PG 子进程）
  await new Promise(() => {});
}

async function stop() {
  const pidFile = resolve(DB_DIR, "postmaster.pid");
  if (!existsSync(pidFile)) {
    console.log("[dev-db] 未在运行（无 postmaster.pid）");
    return;
  }
  const pid = parseInt(readFileSync(pidFile, "utf8").split("\n")[0], 10);
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[dev-db] 已发送停止信号（postmaster pid ${pid}）`);
  } catch {
    console.log(`[dev-db] 进程不存在，可删除 ${DB_DIR} 后重新初始化`);
  }
}

async function status() {
  const running = await probePort();
  console.log(running ? `[dev-db] 运行中 ${PG_URL}` : "[dev-db] 未运行");
}

/** ensure 模式：predev 钩子调用——已运行直接返回；未运行则后台拉起并等待就绪 */
async function ensure() {
  if (await probePort()) {
    writeEnvLocal();
    console.log("[dev-db] 嵌入式 PostgreSQL 已在运行");
    return;
  }
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
  const log = createWriteStream(LOG_FILE, { flags: "a" });
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--server"],
    {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", log, log],
    }
  );
  child.unref();
  if (await waitForPort()) {
    writeEnvLocal();
    console.log("[dev-db] 嵌入式 PostgreSQL 已后台启动");
  } else {
    console.error(
      `[dev-db] 启动超时（180s），请查看日志: ${LOG_FILE}，或前台运行 npm run db:dev 观察输出`
    );
    process.exit(1);
  }
}

const mode = process.argv[2] ?? "start";
try {
  if (mode === "--server") await runServer();
  else if (mode === "--stop") await stop();
  else if (mode === "--status") await status();
  else if (mode === "--ensure") await ensure();
  else await runServer();
} catch (err) {
  console.error(`[dev-db] 失败: ${err?.message ?? err}`);
  process.exit(1);
}
