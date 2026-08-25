/**
 * 请求模板 API（pages/api/admin/request-templates.ts）单元测试
 *
 * 覆盖（2026-08-17 审计修复回归）：
 * - PUT 更新：models 非字符串数组 / enabled 非布尔 → 400
 *   （此前与 name/description 不同，直接赋值脏数据写入 configs）
 * - PUT 合法更新仍正常保存
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-security
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  configFindFirst: vi.fn(),
  configUpdate: vi.fn(),
  configCreate: vi.fn(),
  getAdmin: vi.fn(),
  checkCsrfOrigin: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    configs: {
      findFirst: mocks.configFindFirst,
      update: mocks.configUpdate,
      create: mocks.configCreate,
    },
  })),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
}));

vi.mock("@/lib/admin-security", () => ({
  checkCsrfOrigin: mocks.checkCsrfOrigin,
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/request-templates";

const TEMPLATE = {
  id: "t1",
  name: "旧模板",
  description: "",
  models: ["*"],
  mergeBody: { temperature: 0.7 },
  enabled: true,
};

// configs 行：loadTemplates 与 saveTemplates 各调一次 findFirst，
// 均返回同一行（saveTemplates 走 update 分支）
const CONFIG_ROW = {
  key: "system:request_templates",
  value: JSON.stringify([TEMPLATE]),
  updatedAt: 0,
};

function makeReq(overrides: any = {}): NextApiRequest {
  return {
    method: "GET",
    headers: { host: "example.com" },
    body: {},
    cookies: {},
    ...overrides,
  } as unknown as NextApiRequest;
}

function makeRes(): NextApiResponse {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  const res: any = {
    headers,
    status(c: number) { statusCode = c; return res; },
    json(b: unknown) { body = b; return res; },
    setHeader(k: string, v: string) { headers[k] = v; return res; },
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
  return res;
}

async function call(method: string, body: any = {}) {
  const req = makeReq({ method, body });
  const res = makeRes();
  await handler(req, res);
  return { req, res: res as any };
}

const ADMIN = { adminId: "admin-1", username: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.checkCsrfOrigin.mockReturnValue(true);
  mocks.configFindFirst.mockResolvedValue(CONFIG_ROW);
  mocks.configUpdate.mockResolvedValue({});
  mocks.configCreate.mockResolvedValue({});
});

// ==================== PUT — 更新模板 ====================

describe("PUT /api/admin/request-templates", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call("PUT", { id: "t1" });
    expect(res.statusCode).toBe(401);
  });

  it("缺少 id 返回 400", async () => {
    const { res } = await call("PUT", { name: "新名" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("ID");
  });

  it("模板不存在返回 404", async () => {
    mocks.configFindFirst.mockResolvedValue({ ...CONFIG_ROW, value: "[]" });
    const { res } = await call("PUT", { id: "no-such" });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain("模板不存在");
  });

  it("models 非数组返回 400（此前直接赋值脏数据）", async () => {
    const { res } = await call("PUT", { id: "t1", models: "gpt-4o" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("字符串数组");
    expect(mocks.configUpdate).not.toHaveBeenCalled();
  });

  it("models 数组含非字符串元素返回 400", async () => {
    const { res } = await call("PUT", { id: "t1", models: ["gpt-4o", 123] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("字符串数组");
    expect(mocks.configUpdate).not.toHaveBeenCalled();
  });

  it("enabled 非布尔返回 400", async () => {
    const { res } = await call("PUT", { id: "t1", enabled: "false" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("布尔值");
    expect(mocks.configUpdate).not.toHaveBeenCalled();
  });

  it("合法更新 models/enabled 保存成功", async () => {
    const { res } = await call("PUT", {
      id: "t1",
      models: ["gpt-4o", "claude-*"],
      enabled: false,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.models).toEqual(["gpt-4o", "claude-*"]);
    expect(res.body.data.enabled).toBe(false);
    // saveTemplates 走 update 分支
    expect(mocks.configUpdate).toHaveBeenCalled();
    const saved = JSON.parse(mocks.configUpdate.mock.calls[0][0].data.value);
    expect(saved[0].models).toEqual(["gpt-4o", "claude-*"]);
    expect(saved[0].enabled).toBe(false);
  });

  it("models 空数组归一化为通配符（与 POST 一致，避免落库死模板）", async () => {
    const { res } = await call("PUT", { id: "t1", models: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.models).toEqual(["*"]);
  });
});

describe("PUT /api/admin/request-templates updatedAt 单调递增补偿", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("库中 updatedAt 较大时新写入取 max+1（读库取 max，多实例安全）", async () => {
    // 固定自然秒 = 1784000000；库中已有行 updatedAt 更大
    // （模拟其他实例刚写过：纯进程内补偿方案下本实例会写出更小的自然秒值）
    vi.useFakeTimers();
    vi.setSystemTime(1_784_000_000_000);
    mocks.configFindFirst.mockResolvedValue({
      ...CONFIG_ROW,
      updatedAt: 1_784_000_100,
    });

    const { res } = await call("PUT", { id: "t1", enabled: false });

    expect(res.statusCode).toBe(200);
    expect(mocks.configUpdate).toHaveBeenCalled();
    // 写入值 = 库中当前值 +1（而非自然秒），相对库中最新值单调递增，
    // 保证 worker 模板缓存的 updatedAt 等值失效检查能感知本次保存
    expect(mocks.configUpdate.mock.calls[0][0].data.updatedAt).toBe(1_784_000_101);
  });
});