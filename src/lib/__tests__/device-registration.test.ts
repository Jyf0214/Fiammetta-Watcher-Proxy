/**
 * 设备注册（src/lib/device-registration.ts）单元测试
 *
 * 覆盖：
 * - 首次注册：deviceName 不存在时插入新行（新 UUID）
 * - 重启复用：deviceName 命中时复用 UUID + 累加 bootCount + 刷新 lastSeenAt
 * - 单飞：并发调用共享同一 Promise，不产生重复 INSERT
 * - 设备名为空 → 不注册，返回 registered:false
 * - DB 异常 → 不抛错，返回 registered:false（不阻塞启动）
 *
 * Mock 策略：mock @/lib/prisma.createDb 返回链式 upsert；node-name 由环境变量
 * 直接驱动（与 node-name.test.ts 同模式）。upsert 是 2026-08-30 引入的
 * TOCTOU 修复（之前用 findUnique+create，并发可能撞 P2002）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    deviceRegistrations: {
      upsert: mocks.upsert,
    },
  })),
}));

import {
  registerDevice,
  __resetDeviceRegistrationForTests,
} from "../device-registration";

/**
 * upsert mock 行为模拟器：
 * - 传入 where.deviceName 与已有行匹配 → 返回 update 分支结果（bootCount+1）
 * - 不匹配 → 返回 create 分支结果（bootCount=1）
 */
function setupUpsertMock(existing: { bootCount: number; uuid: string } | null) {
  mocks.upsert.mockImplementation(async ({ where, create, update }: any) => {
    if (existing && where.deviceName === create.deviceName) {
      // 命中 update 分支：模拟 Prisma 翻译 increment → bootCount + 1
      return {
        id: "row-1",
        deviceName: create.deviceName,
        uuid: existing.uuid,
        platform: create.platform,
        address: update.address,
        appVersion: update.appVersion,
        firstSeenAt: 1700000000,
        lastSeenAt: update.lastSeenAt,
        bootCount: existing.bootCount + 1,
      };
    }
    // 命中 create 分支
    return {
      id: create.id,
      deviceName: create.deviceName,
      uuid: create.uuid,
      platform: create.platform,
      address: create.address,
      appVersion: create.appVersion,
      firstSeenAt: create.firstSeenAt,
      lastSeenAt: create.lastSeenAt,
      bootCount: create.bootCount,
    };
  });
}

describe("device-registration", () => {
  beforeEach(() => {
    delete process.env.NODE_NAME;
    delete process.env.DEPLOY_PLATFORM;
    mocks.upsert.mockReset();
    __resetDeviceRegistrationForTests();
  });

  afterEach(() => {
    delete process.env.NODE_NAME;
    delete process.env.DEPLOY_PLATFORM;
    __resetDeviceRegistrationForTests();
  });

  it("首次注册：deviceName 不存在 → 插入新行", async () => {
    process.env.NODE_NAME = "node-1";
    process.env.DEPLOY_PLATFORM = "docker";
    setupUpsertMock(null);
    const nowSec = Math.floor(Date.now() / 1000);

    const result = await registerDevice("10.0.0.1");

    expect(result.registered).toBe(true);
    expect(result.deviceName).toBe("node-1");
    expect(result.platform).toBe("docker");
    expect(result.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const call = mocks.upsert.mock.calls[0][0];
    expect(call.where.deviceName).toBe("node-1");
    expect(call.create.deviceName).toBe("node-1");
    expect(call.create.platform).toBe("docker");
    expect(call.create.address).toBe("10.0.0.1");
    expect(call.create.bootCount).toBe(1);
    expect(call.create.firstSeenAt).toBeGreaterThanOrEqual(nowSec);
    expect(call.create.firstSeenAt).toBe(call.create.lastSeenAt);
  });

  it("重启复用：deviceName 命中 → 复用 UUID + 累加 bootCount", async () => {
    process.env.NODE_NAME = "node-1";
    process.env.DEPLOY_PLATFORM = "docker";
    setupUpsertMock({ bootCount: 5, uuid: "fixed-uuid-1234" });

    const result = await registerDevice("10.0.0.1");

    expect(result.registered).toBe(true);
    expect(result.uuid).toBe("fixed-uuid-1234"); // 复用既有 UUID
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const call = mocks.upsert.mock.calls[0][0];
    expect(call.where.deviceName).toBe("node-1");
    expect(call.update.bootCount).toEqual({ increment: 1 });
    expect(call.update.address).toBe("10.0.0.1");
  });

  it("单飞：并发调用共享同一 Promise，不产生重复 INSERT", async () => {
    process.env.NODE_NAME = "node-1";
    process.env.DEPLOY_PLATFORM = "docker";

    let resolveUpsert: (v: any) => void;
    const upsertPromise = new Promise<any>((resolve) => { resolveUpsert = resolve; });
    mocks.upsert.mockReturnValue(upsertPromise);

    const p1 = registerDevice();
    const p2 = registerDevice();
    const p3 = registerDevice();

    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    resolveUpsert!({
      id: "row-1",
      deviceName: "node-1",
      uuid: "uuid-a",
      platform: "docker",
      address: null,
      appVersion: null,
      firstSeenAt: 0,
      lastSeenAt: 0,
      bootCount: 1,
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
    expect(mocks.upsert).toHaveBeenCalledTimes(1); // 单飞证明
  });

  it("NODE_NAME 全非法 + DEPLOY_PLATFORM 未识别 → 设备名回退 platform 友好名", async () => {
    process.env.NODE_NAME = "\n,\r\"'";
    process.env.DEPLOY_PLATFORM = "custom";
    setupUpsertMock(null);

    const result = await registerDevice();

    // NODE_NAME 全非法 → 回退 friendlyDeployPlatform("custom") = "custom"
    expect(result.registered).toBe(true);
    expect(result.deviceName).toBe("custom");
    expect(result.platform).toBe("local"); // 未知平台归 local
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });

  it("DEPLOY_PLATFORM=unknown 归类为 local，NODE_NAME 仍按清洗后值注册", async () => {
    process.env.NODE_NAME = "  hello  ";
    process.env.DEPLOY_PLATFORM = "kubernetes";
    setupUpsertMock(null);

    const result = await registerDevice();
    expect(result.registered).toBe(true);
    expect(result.deviceName).toBe("hello"); // 前后空白被 trim
    expect(result.platform).toBe("local"); // 未知平台
  });

  it("DB 异常 → 不抛错，返回 registered:false", async () => {
    process.env.NODE_NAME = "node-1";
    process.env.DEPLOY_PLATFORM = "docker";
    mocks.upsert.mockRejectedValue(new Error("DB down"));

    const result = await registerDevice();

    expect(result.registered).toBe(false);
    expect(result.uuid).toBe(null);
    expect(result.deviceName).toBe("node-1"); // 设备名仍返回，便于日志
  });

  it("DEPLOY_PLATFORM=edgeone/vercel/cf/local 正确归类", async () => {
    process.env.NODE_NAME = "node-x";
    setupUpsertMock(null);

    for (const platform of ["edgeone", "vercel", "cf", "local", "unknown"]) {
      __resetDeviceRegistrationForTests();
      mocks.upsert.mockClear();
      process.env.DEPLOY_PLATFORM = platform;
      const r = await registerDevice();
      const expected = platform === "unknown" ? "local" : platform;
      expect(r.platform).toBe(expected);
    }
  });
});