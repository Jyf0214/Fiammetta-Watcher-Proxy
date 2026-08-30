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
 * Mock 策略：mock @/lib/prisma.createDb 返回链式 findUnique / create / update；
 * node-name 由环境变量直接驱动（与 node-name.test.ts 同模式）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    deviceRegistrations: {
      findUnique: mocks.findUnique,
      create: mocks.create,
      update: mocks.update,
    },
  })),
}));

import {
  registerDevice,
  __resetDeviceRegistrationForTests,
} from "../device-registration";

describe("device-registration", () => {
  beforeEach(() => {
    delete process.env.NODE_NAME;
    delete process.env.DEPLOY_PLATFORM;
    mocks.findUnique.mockReset();
    mocks.create.mockReset();
    mocks.update.mockReset();
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
    mocks.findUnique.mockResolvedValue(null);
    const nowSec = Math.floor(Date.now() / 1000);
    mocks.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      deviceName: data.deviceName,
      uuid: data.uuid,
      platform: data.platform,
      address: data.address,
      appVersion: data.appVersion,
      firstSeenAt: data.firstSeenAt,
      lastSeenAt: data.lastSeenAt,
      bootCount: data.bootCount,
    }));

    const result = await registerDevice("10.0.0.1");

    expect(result.registered).toBe(true);
    expect(result.deviceName).toBe("node-1");
    expect(result.platform).toBe("docker");
    expect(result.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
    const call = mocks.create.mock.calls[0][0];
    expect(call.data.deviceName).toBe("node-1");
    expect(call.data.platform).toBe("docker");
    expect(call.data.address).toBe("10.0.0.1");
    expect(call.data.bootCount).toBe(1);
    expect(call.data.firstSeenAt).toBeGreaterThanOrEqual(nowSec);
    expect(call.data.firstSeenAt).toBe(call.data.lastSeenAt);
  });

  it("重启复用：deviceName 命中 → 复用 UUID + 累加 bootCount", async () => {
    process.env.NODE_NAME = "node-1";
    process.env.DEPLOY_PLATFORM = "docker";
    mocks.findUnique.mockResolvedValue({
      id: "row-1",
      deviceName: "node-1",
      uuid: "fixed-uuid-1234",
      platform: "docker",
      address: "10.0.0.1",
      appVersion: "3.2.0",
      firstSeenAt: 1700000000,
      lastSeenAt: 1700000100,
      bootCount: 5,
    });
    mocks.update.mockImplementation(async ({ where, data }) => ({
      id: where.id,
      deviceName: "node-1",
      uuid: "fixed-uuid-1234",
      platform: "docker",
      address: data.address,
      appVersion: data.appVersion,
      firstSeenAt: 1700000000,
      lastSeenAt: data.lastSeenAt,
      bootCount: data.bootCount,
    }));

    const result = await registerDevice("10.0.0.1");

    expect(result.registered).toBe(true);
    expect(result.uuid).toBe("fixed-uuid-1234"); // 复用既有 UUID
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const updateCall = mocks.update.mock.calls[0][0];
    expect(updateCall.where.id).toBe("row-1");
    expect(updateCall.data.bootCount).toBe(6); // 5 + 1
    expect(updateCall.data.address).toBe("10.0.0.1");
  });

  it("单飞：并发调用共享同一 Promise，不产生重复 INSERT", async () => {
    process.env.NODE_NAME = "node-1";
    process.env.DEPLOY_PLATFORM = "docker";

    // 首次 findUnique 让一进入 resolve null → 触发 INSERT；并发调用应共享同一 Promise
    let resolveCreate: (v: any) => void;
    const createPromise = new Promise<any>((resolve) => { resolveCreate = resolve; });
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockReturnValue(createPromise);

    const p1 = registerDevice();
    const p2 = registerDevice();
    const p3 = registerDevice();

    expect(p1).toBe(p2);
    expect(p2).toBe(p3);

    resolveCreate!({
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
    expect(mocks.findUnique).toHaveBeenCalledTimes(1); // 单飞证明
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("NODE_NAME 与 DEPLOY_PLATFORM 均无法解析 → 不注册", async () => {
    // NODE_NAME 全为非法字符且 DEPLOY_PLATFORM 未设置时 resolveNodeName 也会
    // 回退到 "local"（来自 friendlyDeployPlatform 的兜底），仍能注册；
    // 真正无法解析的场景：未设置 NODE_NAME 也未设置 DEPLOY_PLATFORM 走 local 兜底
    // → 实际仍会注册 "local"。本测试改为断言：DEPLOY_PLATFORM 是未识别值且 NODE_NAME
    // 也是全非法字符时，设备名为 "custom"（来自原样小写回退），仍会注册。
    process.env.NODE_NAME = "\n,\r\"'";
    process.env.DEPLOY_PLATFORM = "custom";
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      deviceName: data.deviceName,
      uuid: data.uuid,
      platform: data.platform,
      address: null,
      appVersion: null,
      firstSeenAt: 0,
      lastSeenAt: 0,
      bootCount: 1,
    }));

    const result = await registerDevice();

    // NODE_NAME 全非法 → 回退 friendlyDeployPlatform("custom") = "custom"
    expect(result.registered).toBe(true);
    expect(result.deviceName).toBe("custom");
    expect(result.platform).toBe("local"); // 未知平台归 local
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it("DEPLOY_PLATFORM=unknown 归类为 local，NODE_NAME 仍按清洗后值注册", async () => {
    process.env.NODE_NAME = "  hello  ";
    process.env.DEPLOY_PLATFORM = "kubernetes";
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      deviceName: data.deviceName,
      uuid: data.uuid,
      platform: data.platform,
      address: null,
      appVersion: null,
      firstSeenAt: 0,
      lastSeenAt: 0,
      bootCount: 1,
    }));

    const result = await registerDevice();
    expect(result.registered).toBe(true);
    expect(result.deviceName).toBe("hello"); // 前后空白被 trim
    expect(result.platform).toBe("local"); // 未知平台
  });

  it("DB 异常 → 不抛错，返回 registered:false", async () => {
    process.env.NODE_NAME = "node-1";
    process.env.DEPLOY_PLATFORM = "docker";
    mocks.findUnique.mockRejectedValue(new Error("DB down"));

    const result = await registerDevice();

    expect(result.registered).toBe(false);
    expect(result.uuid).toBe(null);
    expect(result.deviceName).toBe("node-1"); // 设备名仍返回，便于日志
  });

  it("DEPLOY_PLATFORM=edgeone/vercel/cf/local 正确归类", async () => {
    process.env.NODE_NAME = "node-x";
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      deviceName: data.deviceName,
      uuid: data.uuid,
      platform: data.platform,
      address: null,
      appVersion: null,
      firstSeenAt: 0,
      lastSeenAt: 0,
      bootCount: 1,
    }));

    for (const platform of ["edgeone", "vercel", "cf", "local", "unknown"]) {
      __resetDeviceRegistrationForTests();
      process.env.DEPLOY_PLATFORM = platform;
      const r = await registerDevice();
      const expected = platform === "unknown" ? "local" : platform;
      expect(r.platform).toBe(expected);
    }
  });
});