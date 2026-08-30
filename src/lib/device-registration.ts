// ================================================================
// 设备注册（启动时按 NODE_NAME 注册/复用 UUID）
//
// 行为契约：
//   - 每次服务实例启动时调用一次 registerDevice()，按清洗后的 deviceName
//     查表：命中则复用该记录的 UUID 并刷新 lastSeenAt / bootCount；未命中
//     则插入新行（新 UUID + 平台 + 首次注册时间）。
//   - 内存单飞：process 全局 Promise 缓存，重复调用共享同一请求，
//     避免并发启动路径下产生重复 INSERT。
//
// 部署矩阵：
//   - Docker / Docker-lite：docker-entrypoint 启动时调用一次
//   - EdgeOne / Vercel / 本地开发：不在启动期调用（管理后台可见空表）
//   - Cloudflare（Worker + Pages）：CF stub alias 让本文件不被 import，业务层零访问
//
// 入口脚本：
//   - .build/register-device.cjs（由 scripts/build-register-device.mjs 打包，
//     Docker entrypoint 启动时调用），与 .build/scheduler.cjs 同模式 esbuild 内联
// ================================================================

import { createDb } from "@/lib/prisma";
import { resolveNodeName } from "@/lib/node-name";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

/** 设备注册结果 */
export interface DeviceRegistrationResult {
  /** 是否执行了数据库操作（DEPLOY_PLATFORM=cf 或设备名为空时为 false） */
  registered: boolean;
  /** 复用既有记录的 UUID 或新建的 UUID；不注册时为 null */
  uuid: string | null;
  /** 数据库行 ID；不注册时为 null */
  id: string | null;
  /** 解析后的设备名（清洗后），用于日志 */
  deviceName: string | null;
  /** 平台（edgeone/vercel/docker/cf/local）；不注册时为 null */
  platform: string | null;
}

/** 内存单飞：进程内仅首次调用实际执行数据库操作，后续调用共享同一 Promise */
let cachedPromise: Promise<DeviceRegistrationResult> | null = null;

/**
 * 部署平台 → 数据库 platform 字段值映射。
 * device_registrations.platform 列存的字符串，便于管理后台筛选。
 */
function resolvePlatform(raw: string | undefined): string {
  const p = (raw ?? process.env.DEPLOY_PLATFORM ?? "").trim().toLowerCase();
  if (p === "edgeone" || p === "vercel" || p === "docker" || p === "cf") return p;
  return "local";
}

/**
 * 读取 package.json 的 version（部署版本，便于追踪运行实例版本）。
 * 构建/打包后产物路径不同，统一用 process.cwd() 兜底，失败返回 null。
 */
function readAppVersion(): string | null {
  try {
    const candidates = [
      resolve(process.cwd(), "package.json"),
      resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "package.json"),
    ];
    for (const file of candidates) {
      try {
        const raw = readFileSync(file, "utf8");
        const pkg = JSON.parse(raw) as { version?: unknown };
        if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
      } catch {
        // 试下一个候选
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 设备注册入口（单飞）
 *
 * @param address 可选：设备 IP 标识（Docker 取容器 IP、CF Workers 取 clientIP、本地为 local）。
 *                不传时写 null。
 */
export function registerDevice(address?: string | null): Promise<DeviceRegistrationResult> {
  if (cachedPromise) return cachedPromise;
  cachedPromise = doRegister(typeof address === "string" ? address : null);
  return cachedPromise;
}

/**
 * 测试用：清空单飞缓存（让下一次 registerDevice 实际执行数据库操作）。
 * 仅供 vitest 调用，生产代码不应使用。
 */
export function __resetDeviceRegistrationForTests(): void {
  cachedPromise = null;
}

async function doRegister(address: string | null): Promise<DeviceRegistrationResult> {
  const deviceName = resolveNodeName();
  const platform = resolvePlatform(process.env.DEPLOY_PLATFORM);

  // 设备名为空（NODE_NAME 全为非法字符且 DEPLOY_PLATFORM 也无法解析）——不注册
  if (!deviceName) {
    console.warn("[device-registration] 设备名为空，跳过注册（请检查 NODE_NAME / DEPLOY_PLATFORM）");
    return { registered: false, uuid: null, id: null, deviceName: null, platform };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const appVersion = readAppVersion();

  try {
    const db = await createDb();

    // upsert：单条 SQL 同时完成"查重/插入/更新"，消除 findUnique+create 间的
    // TOCTOU 窗口（多实例同 deviceName 并发启动时，DB 层 UNIQUE 约束 + upsert
    // 语义兜底，不会出现"两条记录"或"抛 P2002 导致启动失败"）。
    //
    // Prisma 7 的 increment 在 update 内部翻译为 `bootCount = bootCount + 1`，
    // 由数据库保证原子累加（SQLite/D1 串行写、PostgreSQL/MySQL 行锁），无
    // read-modify-write 竞争。address/appVersion 每次启动用最新值覆盖是预期
    // 行为（容器 IP 不固定 / 部署新版本）。
    const newUuid = crypto.randomUUID();
    const result = await db.deviceRegistrations.upsert({
      where: { deviceName },
      create: {
        id: crypto.randomUUID(),
        deviceName,
        uuid: newUuid,
        platform,
        address: address ?? null,
        appVersion: appVersion ?? null,
        firstSeenAt: nowSec,
        lastSeenAt: nowSec,
        bootCount: 1,
        createdAt: nowSec,
        updatedAt: nowSec,
      },
      update: {
        lastSeenAt: nowSec,
        bootCount: { increment: 1 },
        address: address ?? null,
        appVersion: appVersion ?? null,
        updatedAt: nowSec,
      },
    });
    if (result.bootCount === 1) {
      console.log(`[device-registration] 新设备已注册: ${deviceName} uuid=${result.uuid} platform=${platform}`);
    } else {
      console.log(
        `[device-registration] 复用既有设备: ${deviceName} uuid=${result.uuid} bootCount=${result.bootCount}`
      );
    }
    return {
      registered: true,
      uuid: result.uuid,
      id: result.id,
      deviceName: result.deviceName,
      platform: result.platform,
    };
  } catch (err) {
    // 注册失败不阻塞启动：仅记日志。设备档案属增强信息，DB 瞬时不可用时
    // 不应让容器启动失败——docker-entrypoint 会捕获非零退出导致容器 restart loop。
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[device-registration] 注册失败: ${deviceName} (${platform}): ${msg}`);
    return { registered: false, uuid: null, id: null, deviceName, platform };
  }
}