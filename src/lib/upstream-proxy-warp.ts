/**
 * 出站代理 — Cloudflare Warp 内置代理源（共享层）
 *
 * 定位：warp 不是订阅源，是容器内 warp-cli daemon 暴露的本地 SOCKS5/HTTP 代理
 * （127.0.0.1:40000，Cloudflare 官方 Local proxy mode）。在出站代理 UI 中作为
 * 一个"特殊代理组"出现——前端看不出区别（复用现有出站代理页 + 行内启用开关），
 * 后端 API 契约不变；代码内部按独立 config key（system:upstream_proxy_warp）
 * 识别后特殊路由。
 *
 * 三端共享：与 src/lib/upstream-proxy.ts 同模式。Worker / Pages V1 端
 * （workerd 运行时）无本地进程与端口监听能力，warp 在三端共享层中**仅 Docker
 * 部署有效**，Worker / Pages v1 / proxy-lite 端 import 但不实际生效。
 *
 * 配置存储：configs 表 key=system:upstream_proxy_warp，value 为 JSON：
 *   {
 *     "enabled": true,
 *     "consent": {
 *       "trafficViaCloudflare": true,
 *       "privacyPolicyRead": true,
 *       "policyVersion": "2026-09",
 *       "consentedAt": 1757059200
 *     },
 *     "host": "127.0.0.1",
 *     "port": 40000,
 *     "mode": "socks5",
 *     "updatedAt": 1757059200
 *   }
 *
 * 进程管理：主应用 server.js 内 child_process.spawn('warp-cli', ['connect'])，
 * warp-svc 作为主应用子进程。Docker 部署（DEPLOY_PLATFORM=docker）下生效；
 * 非 Docker 部署（CF / EdgeOne / Vercel）warp.enabled=true 不报错但 spawn
 * 失败被吞掉，业务走直连。
 *
 * 启用流程：
 * 1. 前端 antd Modal 启用前置弹窗（两个必勾选 + Cloudflare 隐私政策外链）
 * 2. PATCH /api/admin/upstream-proxy/warp 写库
 * 3. 同步触发主应用内 spawn warp-cli connect（如果是 Docker 部署）
 * 4. 容器重启后 docker-entrypoint 按 enabled 自动 warp-cli connect &
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createDb } from "@/lib/prisma";
import type { WorkerEnv } from "../../worker/src/config";

/** configs 表中存储 warp 配置的 key（与现有出站代理三键分离同模式） */
export const UPSTREAM_PROXY_WARP_KEY = "system:upstream_proxy_warp";

/** Cloudflare 隐私政策版本号：政策文本变更时递增，强制用户重新勾选 */
export const WARP_PRIVACY_POLICY_VERSION = "2026-09";

/** Cloudflare 隐私政策外链（启用前置弹窗使用） */
export const WARP_PRIVACY_POLICY_URL = "https://www.cloudflare.com/privacypolicy/";

/** Cloudflare 服务条款外链 */
export const WARP_TERMS_URL = "https://www.cloudflare.com/terms/";

/** warp 协议模式（当前固定 socks5，warp-cli Local proxy 模式默认暴露 socks5） */
export type WarpMode = "socks5";

/** 用户同意记录（启用前置弹窗必填） */
export interface WarpConsent {
  /** 用户明确知晓"请求会经 Cloudflare 网络转发" */
  trafficViaCloudflare: boolean;
  /** 用户已查看 Cloudflare 隐私政策 */
  privacyPolicyRead: boolean;
  /** 隐私政策版本号（与 WARP_PRIVACY_POLICY_VERSION 不一致时强制重新勾选） */
  policyVersion: string;
  /** 用户点击「启用」时刻（unix 秒） */
  consentedAt: number;
}

export interface WarpConfig {
  enabled: boolean;
  consent: WarpConsent;
  host: string;
  port: number;
  mode: WarpMode;
  /** 最近一次配置写入时间（unix 秒） */
  updatedAt: number;
}

export const DEFAULT_WARP_CONFIG: Omit<WarpConfig, "consent" | "updatedAt"> = {
  enabled: false,
  host: "127.0.0.1",
  port: 40000,
  mode: "socks5",
};

/** Warp 运行状态（主应用内 spawn 后写入，供前端展示） */
export interface WarpRuntimeStatus {
  /** warp-svc 子进程 PID（未启动 = null） */
  pid: number | null;
  /** warp-cli 模式（始终 "socks5"，保留字段便于未来扩展） */
  mode: WarpMode;
  /** 健康状态：ok = 127.0.0.1:40000 端口可达；unhealthy = 不可达；stopped = 未启动 */
  health: "ok" | "unhealthy" | "stopped";
  /** warp-svc 实际 RSS（字节，未启动 = null） */
  rssBytes: number | null;
  /** 最近一次状态写入时间（unix 秒） */
  checkedAt: number;
  /** 启动 / 停止的错误消息（成功 = null） */
  error: string | null;
}

export const WARP_RUNTIME_STATUS_KEY = "system:upstream_proxy_warp_status";

/** 缓存：避免每请求穿透 DB（warp 配置极少变化，30s 即可） */
let cachedConfig: WarpConfig | null = null;
let cachedConfigValue: string | null = null;
let lastConfigRefresh = 0;
const CACHE_TTL = 30_000;

let cachedRuntimeStatus: WarpRuntimeStatus | null = null;
let cachedRuntimeValue: string | null = null;
let lastRuntimeRefresh = 0;

/** 主动失效（前端 PATCH 写入 + 状态写入后调用） */
export function invalidateWarpCache(): void {
  lastConfigRefresh = 0;
  lastRuntimeRefresh = 0;
  cachedConfigValue = null;
  cachedRuntimeValue = null;
}

function parseWarpConfig(raw: string | null | undefined): WarpConfig | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const enabled = obj.enabled === true;
  const consentRaw = obj.consent as Record<string, unknown> | undefined;
  const consent: WarpConsent = {
    trafficViaCloudflare: consentRaw?.trafficViaCloudflare === true,
    privacyPolicyRead: consentRaw?.privacyPolicyRead === true,
    policyVersion:
      typeof consentRaw?.policyVersion === "string"
        ? consentRaw.policyVersion
        : WARP_PRIVACY_POLICY_VERSION,
    consentedAt:
      typeof consentRaw?.consentedAt === "number" ? consentRaw.consentedAt : 0,
  };
  return {
    enabled,
    consent,
    host: typeof obj.host === "string" && obj.host ? obj.host : DEFAULT_WARP_CONFIG.host,
    port:
      typeof obj.port === "number" && obj.port > 0 && obj.port < 65536
        ? obj.port
        : DEFAULT_WARP_CONFIG.port,
    mode: "socks5",
    updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : 0,
  };
}

function parseWarpRuntimeStatus(
  raw: string | null | undefined
): WarpRuntimeStatus | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  return {
    pid: typeof obj.pid === "number" ? obj.pid : null,
    mode: "socks5",
    health:
      obj.health === "ok" || obj.health === "unhealthy" || obj.health === "stopped"
        ? obj.health
        : "stopped",
    rssBytes: typeof obj.rssBytes === "number" ? obj.rssBytes : null,
    checkedAt: typeof obj.checkedAt === "number" ? obj.checkedAt : 0,
    error: typeof obj.error === "string" ? obj.error : null,
  };
}

/** 读取 warp 配置（30s 缓存 + 内容失效信号） */
export async function readWarpConfig(
  env?: WorkerEnv | Record<string, unknown>
): Promise<WarpConfig | null> {
  const now = Date.now();
  if (cachedConfig && now - lastConfigRefresh < CACHE_TTL) return cachedConfig;
  const db = await createDb(env as never);
  const row = await db.configs.findUnique({
    where: { key: UPSTREAM_PROXY_WARP_KEY },
  });
  const value = row?.value ?? null;
  if (cachedConfigValue !== null && value === cachedConfigValue) {
    lastConfigRefresh = now;
    return cachedConfig;
  }
  cachedConfigValue = value;
  cachedConfig = parseWarpConfig(value);
  lastConfigRefresh = now;
  return cachedConfig;
}

/** 写入 warp 配置（PATCH 启用 API 调用） */
export async function writeWarpConfig(
  next: Omit<WarpConfig, "updatedAt">,
  env?: WorkerEnv | Record<string, unknown>
): Promise<WarpConfig> {
  const db = await createDb(env as never);
  const withTs: WarpConfig = { ...next, updatedAt: Math.floor(Date.now() / 1000) };
  const value = JSON.stringify(withTs);
  await db.configs.upsert({
    where: { key: UPSTREAM_PROXY_WARP_KEY },
    create: {
      id:
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `warp-${Date.now()}`,
      key: UPSTREAM_PROXY_WARP_KEY,
      value,
    },
    update: { value },
  });
  invalidateWarpCache();
  return withTs;
}

/** 读取 warp 运行状态（主应用 spawn 后写入） */
export async function readWarpRuntimeStatus(
  env?: WorkerEnv | Record<string, unknown>
): Promise<WarpRuntimeStatus | null> {
  const now = Date.now();
  if (cachedRuntimeStatus && now - lastRuntimeRefresh < CACHE_TTL) {
    return cachedRuntimeStatus;
  }
  const db = await createDb(env as never);
  const row = await db.configs.findUnique({
    where: { key: WARP_RUNTIME_STATUS_KEY },
  });
  const value = row?.value ?? null;
  if (cachedRuntimeValue !== null && value === cachedRuntimeValue) {
    lastRuntimeRefresh = now;
    return cachedRuntimeStatus;
  }
  cachedRuntimeValue = value;
  cachedRuntimeStatus = parseWarpRuntimeStatus(value);
  lastRuntimeRefresh = now;
  return cachedRuntimeStatus;
}

/** 写入 warp 运行状态 */
export async function writeWarpRuntimeStatus(
  status: WarpRuntimeStatus,
  env?: WorkerEnv | Record<string, unknown>
): Promise<void> {
  const db = await createDb(env as never);
  const value = JSON.stringify(status);
  await db.configs.upsert({
    where: { key: WARP_RUNTIME_STATUS_KEY },
    create: {
      id:
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `warp-status-${Date.now()}`,
      key: WARP_RUNTIME_STATUS_KEY,
      value,
    },
    update: { value },
  });
  invalidateWarpCache();
}

/**
 * 检查 warp 是否"应启用"：enabled=true + 用户双勾选 + 隐私政策版本一致。
 * 缺一不可——任一缺失视为未启用（避免旧 consent 复活 / 政策变更后用户未重新确认）
 */
export function isWarpEffectivelyEnabled(config: WarpConfig | null): boolean {
  if (!config || !config.enabled) return false;
  if (!config.consent.trafficViaCloudflare || !config.consent.privacyPolicyRead) return false;
  if (config.consent.policyVersion !== WARP_PRIVACY_POLICY_VERSION) return false;
  return true;
}

// ============================================================
// 设备级控制：device_registrations.warp_enabled
// ============================================================

/**
 * 按 deviceName 查本设备的 warp 启用状态。
 *
 * 设计语义（多实例 + 设备自治）：
 * - 每台设备启动时按 NODE_NAME 查自己行（device_registrations.device_name 唯一索引）
 * - 该设备 warp_enabled=true → 该设备实例可拉起 warp-cli
 * - 该设备 warp_enabled=false → 该设备实例即使 system:upstream_proxy_warp.enabled=true
 *   也不应拉起（管理后台独立控制每台设备）
 * - 设备未注册（DEPLOY_PLATFORM != docker / CF / 设备记录被删）→ 返回 false
 *   （保守：未注册 = 不拉起 warp，与"未授权"语义一致）
 *
 * 复用 warp config 30s 内容缓存：device 启用变更通过 PATCH API 写库后，主进程
 * 5s polling tick 拉到新值自动 reconcile（无需跨进程 IPC）。
 */
export async function isThisDeviceWarpEnabled(
  env?: WorkerEnv | Record<string, unknown>
): Promise<boolean> {
  // 非 Docker 部署根本无 warp-cli，一刀切
  if (process.env.DEPLOY_PLATFORM !== "docker") return false;
  // 复用 resolveNodeName（与 device-registration.ts 同源）：保证 deviceName 一致
  let deviceName: string | null;
  try {
    const { resolveNodeName } = await import("@/lib/node-name");
    deviceName = resolveNodeName();
  } catch {
    return false;
  }
  if (!deviceName) return false;
  try {
    const db = await createDb(env as never);
    const row = await db.deviceRegistrations.findUnique({
      where: { deviceName },
      select: { warpEnabled: true },
    });
    return row?.warpEnabled === true;
  } catch {
    // 查表失败保守返回 false：不阻塞业务，宁可 warp 不可用也不误启
    return false;
  }
}

/**
 * 组合判定：本设备 warp 是否应实际启？
 * 三层 AND 关系：
 *   1. 部署形态（仅 Docker）
 *   2. 全局 config 启用 + 用户双勾选 + 政策版本一致（isWarpEffectivelyEnabled）
 *   3. 本设备 device_registrations.warp_enabled=true
 * 任一不满足返回 false。
 */
export async function shouldStartWarpOnThisDevice(
  env?: WorkerEnv | Record<string, unknown>
): Promise<boolean> {
  if (process.env.DEPLOY_PLATFORM !== "docker") return false;
  const cfg = await readWarpConfig(env);
  if (!isWarpEffectivelyEnabled(cfg)) return false;
  return await isThisDeviceWarpEnabled(env);
}

// ============================================================
// 进程管理：主应用内 child_process.spawn 管理 warp-cli / warp-svc
// ============================================================

/** 当前 warp-svc 子进程引用（主进程单例） */
let warpProcess: ChildProcess | null = null;
/** 最近一次 spawn 的启动时间（unix 毫秒） */
let warpSpawnedAt = 0;
/** 启动失败的错误信息（成功 = null） */
let warpSpawnError: string | null = null;

/** 是否在 Docker 部署（DEPLOY_PLATFORM=docker 视为容器） */
function isDockerDeployment(): boolean {
  return process.env.DEPLOY_PLATFORM === "docker";
}

/** 当前是否已就绪（pid 存在且进程未退出） */
export function isWarpProcessRunning(): boolean {
  return warpProcess !== null && warpProcess.exitCode === null && warpProcess.signalCode === null;
}

/**
 * 依据当前 shouldStartWarpOnThisDevice() 状态自动启/停 warp 子进程。
 *
 * 设计语义（设备级 reconcile）：
 * - 调用方：register-device.cjs 启动注册后；scheduler.cjs 健康检查 polling tick；
 *   warp.tsx 用户 PATCH /api/admin/upstream-proxy/warp 写库后。
 * - 决策表：
 *     shouldStart=true  & 进程已跑  → noop
 *     shouldStart=true  & 进程未跑  → startWarpProcess
 *     shouldStart=false & 进程已跑  → stopWarpProcess
 *     shouldStart=false & 进程未跑  → noop
 * - 任一异常（spawn 失败 / 查表失败）仅记日志不抛错：reconcile 失败不应阻塞
 *   scheduler tick 或 register-device 主流程。
 */
export async function reconcileWarp(): Promise<{
  action: "start" | "stop" | "noop";
  reason: string;
  ok: boolean;
  error?: string;
}> {
  let shouldStart: boolean;
  try {
    shouldStart = await shouldStartWarpOnThisDevice();
  } catch (err) {
    console.warn(
      `[upstream-proxy-warp] reconcile: shouldStartWarpOnThisDevice 异常: ${(err as Error)?.message ?? String(err)}`
    );
    return { action: "noop", reason: "决策异常", ok: false, error: String(err) };
  }
  const running = isWarpProcessRunning();
  if (shouldStart && !running) {
    const cfg = await readWarpConfig();
    if (!cfg) return { action: "noop", reason: "config 缺失", ok: false };
    const r = await startWarpProcess(cfg);
    return {
      action: "start",
      reason: "本设备 warp_enabled=true 且 config 已启用",
      ok: r.ok,
      error: r.error,
    };
  }
  if (!shouldStart && running) {
    const r = await stopWarpProcess();
    return {
      action: "stop",
      reason: "本设备 warp_enabled=false 或 config 未启用",
      ok: r.ok,
      error: r.error,
    };
  }
  return {
    action: "noop",
    reason: shouldStart ? "已运行" : "无需启动",
    ok: true,
  };
}

/** 获取当前 warp 子进程 PID（未启动返回 null） */
export function getWarpProcessPid(): number | null {
  return isWarpProcessRunning() && warpProcess?.pid ? warpProcess.pid : null;
}

/** 获取当前 warp 启动错误（成功 = null） */
export function getWarpSpawnError(): string | null {
  return warpSpawnError;
}

/** 获取 warp 启动时刻（unix 毫秒，未启动 = 0） */
export function getWarpSpawnedAt(): number {
  return warpSpawnedAt;
}

/**
 * 在主应用内启动 warp-cli（spawn 子进程 → 实际拉起 warp-svc 监听 40000 端口）
 *
 * 步骤：
 * 1. warp-cli registration new（首次：免账号，自动接受 ToS）
 * 2. warp-cli mode proxy（切到 Local proxy mode，Cloudflare 官方默认 40000 端口）
 * 3. warp-cli connect（拉起 warp-svc daemon，监听 127.0.0.1:40000）
 *
 * 内存限制：spawn 前通过 shell `ulimit -v 98304`（96MB）限制子进程虚拟内存，
 * 解决 warp-svc 已知内存泄漏问题（基线 ~80MB，长时间运行涨到 1GB+）。
 *
 * 失败语义：spawn 失败 / 命令返回非零不抛错，捕获到 warpSpawnError 供前端展示。
 * 主应用继续运行，warp 不可用时 getWarpDispatcher 返回 null，业务走直连。
 */
export async function startWarpProcess(
  config: WarpConfig
): Promise<{ ok: boolean; error?: string }> {
  if (!isDockerDeployment()) {
    return { ok: false, error: "warp 仅 Docker 部署可用" };
  }
  if (isWarpProcessRunning()) {
    return { ok: true };
  }
  warpSpawnError = null;

  // 步骤 1：registration new（首次免账号）
  const regResult = await runWarpCli(["registration", "new"], 30_000);
  // 重复注册 warp-cli 自身会忽略，不视为错误
  if (!regResult.ok && !/already/i.test(regResult.error ?? "")) {
    warpSpawnError = `warp-cli registration new 失败: ${regResult.error}`;
    await writeRuntimeState("unhealthy", null, warpSpawnError);
    return { ok: false, error: warpSpawnError };
  }

  // 步骤 2：mode proxy（切到 Local proxy mode）
  const modeResult = await runWarpCli(["mode", "proxy"], 15_000);
  if (!modeResult.ok) {
    warpSpawnError = `warp-cli mode proxy 失败: ${modeResult.error}`;
    await writeRuntimeState("unhealthy", null, warpSpawnError);
    return { ok: false, error: warpSpawnError };
  }

  // 步骤 3：connect（拉起 warp-svc daemon，受 ulimit 限制）
  // ulimit -v 98304 KB = 96 MB 虚拟内存上限（warp-svc 实测基线 ~80MB，限 96MB 留余量）
  try {
    warpProcess = spawn(
      "sh",
      ["-c", "ulimit -v 98304; exec warp-cli connect"],
      { stdio: "ignore", detached: false }
    );
  } catch (err) {
    warpSpawnError = `spawn warp-cli connect 失败: ${(err as Error).message}`;
    await writeRuntimeState("unhealthy", null, warpSpawnError);
    return { ok: false, error: warpSpawnError };
  }

  warpSpawnedAt = Date.now();
  const pid = warpProcess.pid ?? null;

  // 子进程退出时清理引用
  warpProcess.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
      warpSpawnError = `warp-cli 异常退出 (code=${code}, signal=${signal})`;
    } else {
      warpSpawnError = null;
    }
    warpProcess = null;
    void writeRuntimeState("stopped", null, warpSpawnError);
  });

  // 等待 5s 检查端口是否就绪
  const healthy = await waitForWarpPort(config.host, config.port, 5_000);
  if (!healthy) {
    warpSpawnError = `warp-cli 已启动但 ${config.host}:${config.port} 端口未在 5s 内就绪`;
    await writeRuntimeState("unhealthy", pid, warpSpawnError);
    return { ok: false, error: warpSpawnError };
  }

  await writeRuntimeState("ok", pid, null);
  return { ok: true };
}

/** 停止 warp-cli / warp-svc */
export async function stopWarpProcess(): Promise<{ ok: boolean; error?: string }> {
  if (!isDockerDeployment()) {
    return { ok: false, error: "warp 仅 Docker 部署可用" };
  }
  if (!warpProcess) {
    await writeRuntimeState("stopped", null, null);
    return { ok: true };
  }
  return new Promise((resolve) => {
    const proc = warpProcess;
    if (!proc) {
      resolve({ ok: true });
      return;
    }
    proc.once("exit", () => {
      warpProcess = null;
      warpSpawnError = null;
      void writeRuntimeState("stopped", null, null);
      resolve({ ok: true });
    });
    try {
      proc.kill("SIGTERM");
    } catch (err) {
      resolve({ ok: false, error: `kill 失败: ${(err as Error).message}` });
    }
    // 兜底：5s 后还在，强制 SIGKILL
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }, 5_000).unref();
  });
}

/** 执行一次 warp-cli 子命令（spawn 同步 wait，捕获 stdout/stderr） */
function runWarpCli(
  args: string[],
  timeoutMs: number
): Promise<{ ok: boolean; stdout: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn("warp-cli", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, stdout: "", error: `spawn 失败: ${(err as Error).message}` });
      return;
    }
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, stdout, error: err.message });
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, stdout, error: stderr.trim() || `exit ${code}` });
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ ok: false, stdout, error: `超时 ${timeoutMs}ms` });
    }, timeoutMs).unref();
  });
}

/** 等待端口可达（最多 maxMs 毫秒） */
async function waitForWarpPort(
  host: string,
  port: number,
  maxMs: number
): Promise<boolean> {
  const net = await import("node:net");
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host, port }, () => {
        sock.end();
        resolve(true);
      });
      sock.once("error", () => {
        resolve(false);
      });
      setTimeout(() => {
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        resolve(false);
      }, 1_000).unref();
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** 读取 /proc/[pid]/status 拿 RSS（Linux only；非 Linux 返回 null） */
function readProcessRss(pid: number): number | null {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const content = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const match = content.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    if (match) return Number(match[1]) * 1024;
  } catch {
    /* 非 Linux 或进程已退出 */
  }
  return null;
}

/** 写入 warp 运行状态到 DB（含 RSS 探针） */
async function writeRuntimeState(
  health: WarpRuntimeStatus["health"],
  pid: number | null,
  error: string | null
): Promise<void> {
  const rssBytes = pid !== null ? readProcessRss(pid) : null;
  await writeWarpRuntimeStatus({
    pid,
    mode: "socks5",
    health,
    rssBytes,
    checkedAt: Math.floor(Date.now() / 1000),
    error,
  });
}

/** 周期性健康检查 + RSS 探针（主应用内 setInterval 调用，30s 一次） */
export async function tickWarpHealth(): Promise<void> {
  if (!isWarpProcessRunning()) {
    if (warpProcess !== null) {
      // 已停止
      await writeRuntimeState("stopped", null, null);
    }
    return;
  }
  const pid = warpProcess?.pid ?? null;
  const config = await readWarpConfig();
  if (!config) return;
  const portOk = await waitForWarpPort(config.host, config.port, 1_000);
  const rssBytes = pid !== null ? readProcessRss(pid) : null;
  await writeWarpRuntimeStatus({
    pid,
    mode: "socks5",
    health: portOk ? "ok" : "unhealthy",
    rssBytes,
    checkedAt: Math.floor(Date.now() / 1000),
    error: portOk ? null : `${config.host}:${config.port} 不可达`,
  });
}
