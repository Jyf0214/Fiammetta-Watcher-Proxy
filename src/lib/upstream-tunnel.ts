/**
 * 出站代理 — Cloudflare Tunnel 内置隧道（共享层）
 *
 * 定位：每台设备可独立设置一个 cloudflared tunnel token（base64 JWT，从
 * Cloudflare Zero Trust 复制），本项目主进程按 token 启/停 cloudflared 子进程。
 * 与 warp 不同：warp 是兜底代理（业务流量走它），tunnel 是**入站暴露**
 * （外部通过 tunnel 访问设备内服务）——两者完全独立。
 *
 * 三端共享：与 src/lib/upstream-proxy-warp.ts 同模式。Worker / Pages V1 端
 * （workerd 运行时）无 child_process 能力，tunnel 在三端共享层中**仅 Docker 部署
 * 有效**——非 Docker 端 import 但不实际启进程。Cloudflare 部署下整页 / API
 * 与 warp 同样 503 关闭（与 device_registrations 表无意义对齐）。
 *
 * 设计语义（与 warp 设备管理一致）：
 * - 每台设备独立 1 个 token（device_registrations.tunnel_token 唯一键为 deviceName）
 * - 容器启动后 register-device.cjs 拉起 reconcileTunnel：按 token 决定 spawn
 * - scheduler.cjs 每 5 分钟 tick 同步远端变更（管理后台改 token / 启动 / 停止）
 * - 启动 / 停止 = spawn cloudflared child_process，与 warp 同模式
 *
 * Docker 权限：cloudflared tunnel 出站连接到 Cloudflare 边缘（QUIC/WebSocket），
 * 纯 outbound TCP，**无需 NET_ADMIN / /dev/net/tun**——保留现有 cap_drop: ALL
 * 不动。TUN 设备是用于本地入站服务暴露的，本项目是出站建隧道，不创建 TUN 接口。
 *
 * 启动命令：cloudflared tunnel run --token <TUNNEL_TOKEN>
 * - --no-autoupdate：避免容器内自动更新覆盖运行时文件
 * - stdio ignore：cloudflared 输出量大（连接日志），吞掉不污染主进程
 *
 * 安全：
 * - tunnelToken 字段明文存储（cloudflared 自身也用明文 token，无加密约定）
 * - API 返回时**脱敏**（只返回前 8 字符 + ...，完整值不返回）
 * - 审计日志 detail **不**包含 token（防泄露）
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createDb } from "@/lib/prisma";
import { resolveNodeName } from "@/lib/node-name";
import type { WorkerEnv } from "../../worker/src/config";

// ============================================================
// 配置存储：device_registrations.tunnel_token + tunnel_started_at + tunnel_started_by
// ============================================================

/** 是否在 Docker 部署（cloudflared 仅 Linux 容器内可运行） */
function isDockerDeployment(): boolean {
  return process.env.DEPLOY_PLATFORM === "docker";
}

/** CF 部署下整页 / API 关闭（与 warp / devices 一致：与 device_registrations 表无意义） */
export function isCloudflareDeployment(): boolean {
  return process.env.DEPLOY_PLATFORM === "cf";
}

/**
 * 读本设备的 tunnel 配置。
 * 返回值 tunnelToken 字段明文，调用方按需脱敏；进程内不做日志输出避免泄露。
 */
export interface DeviceTunnel {
  id: string;
  deviceName: string;
  hasToken: boolean;
  /** token 摘要（前 8 字符 + "..."，用于 UI 展示；调用方需要完整值需另调 readTunnelToken） */
  tokenSummary: string | null;
  tunnelStartedAt: number;
  tunnelStartedBy: string | null;
  /** 当前进程内是否在跑 cloudflared 子进程 */
  running: boolean;
  /** 子进程 PID（未启动 = null） */
  pid: number | null;
}

export function summarizeToken(token: string | null | undefined): string | null {
  if (!token) return null;
  if (token.length <= 12) return token;
  return `${token.slice(0, 8)}...`;
}

/** 读本设备的 tunnel 配置（不自启，仅查表） */
export async function readDeviceTunnel(
  env?: WorkerEnv | Record<string, unknown>
): Promise<DeviceTunnel | null> {
  if (!isDockerDeployment()) return null;
  const deviceName = resolveNodeName();
  if (!deviceName) return null;
  try {
    const db = await createDb(env as never);
    const row = await db.deviceRegistrations.findUnique({
      where: { deviceName },
      select: {
        id: true,
        deviceName: true,
        tunnelToken: true,
        tunnelStartedAt: true,
        tunnelStartedBy: true,
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      deviceName: row.deviceName,
      hasToken: Boolean(row.tunnelToken),
      tokenSummary: summarizeToken(row.tunnelToken),
      tunnelStartedAt: row.tunnelStartedAt,
      tunnelStartedBy: row.tunnelStartedBy,
      running: isTunnelProcessRunning(),
      pid: getTunnelProcessPid(),
    };
  } catch (err) {
    console.warn(
      `[upstream-tunnel] readDeviceTunnel 异常: ${(err as Error)?.message ?? String(err)}`
    );
    return null;
  }
}

/**
 * 读本设备的 tunnel token 明文（仅进程内使用，**不**写日志，**不**走 API 响应）。
 * 设计意图：startTunnelProcess 需要明文 spawn cloudflared。
 */
export async function readTunnelToken(
  env?: WorkerEnv | Record<string, unknown>
): Promise<string | null> {
  if (!isDockerDeployment()) return null;
  const deviceName = resolveNodeName();
  if (!deviceName) return null;
  try {
    const db = await createDb(env as never);
    const row = await db.deviceRegistrations.findUnique({
      where: { deviceName },
      select: { tunnelToken: true },
    });
    return row?.tunnelToken ?? null;
  } catch (err) {
    console.warn(
      `[upstream-tunnel] readTunnelToken 异常: ${(err as Error)?.message ?? String(err)}`
    );
    return null;
  }
}

/** 写 token（管理后台 PATCH 调用） */
export async function writeTunnelToken(
  deviceName: string,
  token: string | null,
  env?: WorkerEnv | Record<string, unknown>
): Promise<void> {
  const db = await createDb(env as never);
  await db.deviceRegistrations.update({
    where: { deviceName },
    data: { tunnelToken: token, updatedAt: Math.floor(Date.now() / 1000) },
  });
}

/** 写 tunnel 启动时间 + 操作人（spawn 成功后调用） */
export async function markTunnelStarted(
  deviceName: string,
  operatorId: string | null,
  env?: WorkerEnv | Record<string, unknown>
): Promise<void> {
  const db = await createDb(env as never);
  const nowSec = Math.floor(Date.now() / 1000);
  await db.deviceRegistrations.update({
    where: { deviceName },
    data: { tunnelStartedAt: nowSec, tunnelStartedBy: operatorId, updatedAt: nowSec },
  });
}

// ============================================================
// 进程管理：主应用内 child_process.spawn 管理 cloudflared
// ============================================================

/** 当前 cloudflared 子进程引用（主进程单例） */
let tunnelProcess: ChildProcess | null = null;
/** spawn 启动时间（unix 毫秒） */
let tunnelSpawnedAt = 0;
/** spawn 错误（成功 = null） */
let tunnelSpawnError: string | null = null;

/** 当前是否已就绪（pid 存在且进程未退出） */
export function isTunnelProcessRunning(): boolean {
  return (
    tunnelProcess !== null &&
    tunnelProcess.exitCode === null &&
    tunnelProcess.signalCode === null
  );
}

/** 获取子进程 PID */
export function getTunnelProcessPid(): number | null {
  return isTunnelProcessRunning() && tunnelProcess?.pid ? tunnelProcess.pid : null;
}

/** 获取 spawn 错误信息（成功 = null） */
export function getTunnelSpawnError(): string | null {
  return tunnelSpawnError;
}

/** 获取 spawn 启动时刻（unix 毫秒，未启动 = 0） */
export function getTunnelSpawnedAt(): number {
  return tunnelSpawnedAt;
}

/** 启动 cloudflared 子进程（带 --token） */
export async function startTunnelProcess(
  token: string,
  operatorId?: string | null
): Promise<{ ok: boolean; error?: string; pid?: number | null }> {
  if (!isDockerDeployment()) {
    return { ok: false, error: "cloudflared tunnel 仅 Docker 部署可用" };
  }
  if (isTunnelProcessRunning()) {
    return { ok: true, pid: getTunnelProcessPid() };
  }
  tunnelSpawnError = null;
  try {
    tunnelProcess = spawn(
      "cloudflared",
      ["tunnel", "run", "--no-autoupdate", "--token", token],
      { stdio: "ignore", detached: false }
    );
  } catch (err) {
    tunnelSpawnError = `spawn cloudflared 失败: ${(err as Error).message}`;
    return { ok: false, error: tunnelSpawnError };
  }
  tunnelSpawnedAt = Date.now();
  const pid = tunnelProcess.pid ?? null;

  tunnelProcess.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
      tunnelSpawnError = `cloudflared 异常退出 (code=${code}, signal=${signal})`;
    } else {
      tunnelSpawnError = null;
    }
    tunnelProcess = null;
  });

  // 标记启动时间 + 操作人
  const deviceName = resolveNodeName();
  if (deviceName) {
    await markTunnelStarted(deviceName, operatorId ?? null).catch((err) => {
      console.warn(
        `[upstream-tunnel] markTunnelStarted 失败: ${(err as Error)?.message ?? String(err)}`
      );
    });
  }

  return { ok: true, pid };
}

/** 停止 cloudflared 子进程 */
export async function stopTunnelProcess(): Promise<{ ok: boolean; error?: string }> {
  if (!isDockerDeployment()) {
    return { ok: false, error: "cloudflared tunnel 仅 Docker 部署可用" };
  }
  if (!tunnelProcess) return { ok: true };
  return new Promise((resolve) => {
    const proc = tunnelProcess;
    if (!proc) {
      resolve({ ok: true });
      return;
    }
    proc.once("exit", () => {
      tunnelProcess = null;
      tunnelSpawnError = null;
      resolve({ ok: true });
    });
    try {
      proc.kill("SIGTERM");
    } catch (err) {
      resolve({ ok: false, error: `kill 失败: ${(err as Error).message}` });
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }, 5_000).unref();
  });
}

/**
 * reconcile：依据本设备 token 状态自动启/停 cloudflared。
 *
 * 决策表（与 reconcileWarp 同模式）：
 *   hasToken & 跑着     → noop
 *   hasToken & 没跑     → startTunnelProcess
 *   !hasToken & 跑着    → stopTunnelProcess
 *   !hasToken & 没跑    → noop
 *
 * 注意：reconcileTunnel **不需要 warp_enabled 那种"全局 + 设备"双层开关**——
 * tunnel 是按 token 自治的：有 token 就起，没 token 就停，与设备级 reconcile
 * 解耦（管理后台设了 token 就自动起，删了 token 就自动停）。
 */
export async function reconcileTunnel(
  operatorId?: string | null
): Promise<{
  action: "start" | "stop" | "noop";
  reason: string;
  ok: boolean;
  error?: string;
}> {
  if (!isDockerDeployment()) {
    return { action: "noop", reason: "非 Docker 部署", ok: true };
  }
  const token = await readTunnelToken();
  const running = isTunnelProcessRunning();
  if (token && !running) {
    const r = await startTunnelProcess(token, operatorId);
    return {
      action: "start",
      reason: "本设备已设 token",
      ok: r.ok,
      error: r.error,
    };
  }
  if (!token && running) {
    const r = await stopTunnelProcess();
    return {
      action: "stop",
      reason: "本设备 token 已清空",
      ok: r.ok,
      error: r.error,
    };
  }
  return {
    action: "noop",
    reason: token ? "已运行" : "未配置 token",
    ok: true,
  };
}
