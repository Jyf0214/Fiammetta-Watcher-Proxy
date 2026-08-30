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

    // 按 deviceName 唯一索引查重；命中则复用 UUID 并累加 bootCount/刷新 lastSeenAt
    const existing = await db.deviceRegistrations.findUnique({
      where: { deviceName },
    });

    if (existing) {
      const updated = await db.deviceRegistrations.update({
        where: { id: existing.id },
        data: {
          lastSeenAt: nowSec,
          bootCount: existing.bootCount + 1,
          // address 与 appVersion 在重启间可能变化（容器 IP 不固定 / 部署新版本），
          // 每次启动用最新值覆盖
          address: address ?? existing.address,
          appVersion: appVersion ?? existing.appVersion,
          updatedAt: nowSec,
        },
      });
      console.log(
        `[device-registration] 复用既有设备: ${deviceName} uuid=${updated.uuid} bootCount=${updated.bootCount}`
      );
      return {
        registered: true,
        uuid: updated.uuid,
        id: updated.id,
        deviceName: updated.deviceName,
        platform: updated.platform,
      };
    }

    const newUuid = crypto.randomUUID();
    const created = await db.deviceRegistrations.create({
      data: {
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
    });
    console.log(`[device-registration] 新设备已注册: ${deviceName} uuid=${created.uuid} platform=${platform}`);
    return {
      registered: true,
      uuid: created.uuid,
      id: created.id,
      deviceName: created.deviceName,
      platform: created.platform,
    };
  } catch (err) {
    // 注册失败不阻塞启动：仅记日志。设备档案属增强信息，DB 瞬时不可用时
    // 不应让容器启动失败——docker-entrypoint 会捕获非零退出导致容器 restart loop。
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[device-registration] 注册失败: ${deviceName} (${platform}): ${msg}`);
    return { registered: false, uuid: null, id: null, deviceName, platform };
  }
}