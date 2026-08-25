/**
 * 平台单个操作 API（pages/api/admin/platforms/[id].ts）单元测试
 *
 * 覆盖（2026-08-18 审计 A6 回归）：
 * - DELETE 级联清理 daily_stats（此前只删 requestLogs + platformModels，
 *   daily_stats 残留导致仪表盘历史统计与日志页数据矛盾）
 * - DELETE 被 model_mappings 引用时拒绝删除
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-security、
 * @/lib/admin-rate-limit、@/lib/key-status、@opennextjs/cloudflare
 * （worker/src/platform-keys、worker/src/load-balancer 使用真实实现，仅 DELETE
 * 路径不触达，导入无副作用）
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  platformFindFirst: vi.fn(),
  platformUpdate: vi.fn(),
  platformDelete: vi.fn(),
  mappingsFindMany: vi.fn(),
  requestLogsDeleteMany: vi.fn(),
  dailyStatsDeleteMany: vi.fn(),
  platformModelsDeleteMany: vi.fn(),
  auditCreate: vi.fn(),
  getAdmin: vi.fn(),
  getAuditAdminId: vi.fn(),
  checkCsrfOrigin: vi.fn(),
  isSafeUrl: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    platforms: {
      findFirst: mocks.platformFindFirst,
      update: mocks.platformUpdate,
      delete: mocks.platformDelete,
    },
    modelMappings: {
      findMany: mocks.mappingsFindMany,
    },
    requestLogs: {
      deleteMany: mocks.requestLogsDeleteMany,
    },
    dailyStats: {
      deleteMany: mocks.dailyStatsDeleteMany,
    },
    platformModels: {
      deleteMany: mocks.platformModelsDeleteMany,
    },
    auditLogs: {
      create: mocks.auditCreate,
    },
  })),
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
  getAuditAdminId: mocks.getAuditAdminId,
}));

vi.mock("@/lib/admin-security", () => ({
  checkCsrfOrigin: mocks.checkCsrfOrigin,
  isSafeUrl: mocks.isSafeUrl,
}));

vi.mock("@/lib/admin-rate-limit", () => ({
  checkAdminRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/key-status", () => ({
  readPlatformKeyStatus: vi.fn(async () => ({})),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no Cloudflare context");
  },
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/platforms/[id]";

function makeReq(overrides: any = {}): NextApiRequest {
  return {
    method: "DELETE",
    headers: { host: "example.com" },
    body: {},
    cookies: {},
    query: { id: "p1" },
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

async function call(method: string, body: any = {}, query: any = { id: "p1" }) {
  const req = makeReq({ method, body, query });
  const res = makeRes();
  await handler(req, res);
  return { req, res: res as any };
}

const ADMIN = { adminId: "admin-1", username: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.getAuditAdminId.mockReturnValue("env-admin");
  mocks.checkCsrfOrigin.mockReturnValue(true);
  mocks.isSafeUrl.mockResolvedValue({ safe: true, reason: "" });
  mocks.checkRateLimit.mockResolvedValue(true);
  mocks.mappingsFindMany.mockResolvedValue([]);
  mocks.requestLogsDeleteMany.mockResolvedValue({ count: 5 });
  mocks.dailyStatsDeleteMany.mockResolvedValue({ count: 3 });
  mocks.platformModelsDeleteMany.mockResolvedValue({ count: 2 });
  mocks.platformDelete.mockResolvedValue({});
  mocks.platformUpdate.mockResolvedValue({});
  mocks.auditCreate.mockResolvedValue({});
});

// ==================== DELETE — 级联清理 ====================

describe("DELETE /api/admin/platforms/[id]", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call("DELETE");
    expect(res.statusCode).toBe(401);
  });

  it("被 model_mappings 引用时拒绝删除且不清理任何数据", async () => {
    mocks.mappingsFindMany.mockResolvedValue([{ id: "mm1", platformId: "p1" }]);
    const { res } = await call("DELETE");
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("映射");
    expect(mocks.requestLogsDeleteMany).not.toHaveBeenCalled();
    expect(mocks.dailyStatsDeleteMany).not.toHaveBeenCalled();
    expect(mocks.platformDelete).not.toHaveBeenCalled();
  });

  it("删除时级联清理 daily_stats（A6 回归：此前残留导致统计与日志矛盾）", async () => {
    const { res } = await call("DELETE");
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    // 级联顺序：requestLogs → dailyStats → platformModels → platforms
    expect(mocks.requestLogsDeleteMany).toHaveBeenCalledWith({ where: { platformId: "p1" } });
    expect(mocks.dailyStatsDeleteMany).toHaveBeenCalledWith({ where: { platformId: "p1" } });
    expect(mocks.platformModelsDeleteMany).toHaveBeenCalledWith({ where: { platformId: "p1" } });
    expect(mocks.platformDelete).toHaveBeenCalledWith({ where: { id: "p1" } });
  });

  it("删除时写入审计日志", async () => {
    const { res } = await call("DELETE");
    expect(res.statusCode).toBe(200);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "delete_platform",
          adminId: "env-admin",
          detail: expect.stringContaining('"platformId":"p1"'),
        }),
      })
    );
  });
});

// ==================== PUT — apiKeys 空集守卫（M8 回归） ====================

describe("PUT /api/admin/platforms/[id] — apiKeys 空集守卫", () => {
  const EXISTING = { id: "p1", name: "p", apiKeys: '[{"key":"old"}]' };

  beforeEach(() => {
    // PUT 流程会 findFirst 两次：查 existing、查更新后数据
    mocks.platformFindFirst.mockResolvedValue(EXISTING);
  });

  it("对象数组格式全无效载荷返回 400 且不落库（此前静默清空假成功）", async () => {
    const { res } = await call("PUT", { apiKeys: [{ key: " " }] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("API 密钥不能为空");
    expect(mocks.platformUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("旧字符串数组格式全无效载荷返回 400 且不落库", async () => {
    const { res } = await call("PUT", { apiKeys: [" ", ""] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("API 密钥不能为空");
    expect(mocks.platformUpdate).not.toHaveBeenCalled();
  });

  it("显式空数组 [] 返回 400（与创建端 POST 拒绝 [] 的语义一致）", async () => {
    const { res } = await call("PUT", { apiKeys: [] });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("API 密钥不能为空");
    expect(mocks.platformUpdate).not.toHaveBeenCalled();
  });

  it("空字符串 apiKeys 返回 400 且不落库（此前静默清空全部密钥并假成功）", async () => {
    const { res } = await call("PUT", { apiKeys: "" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("API 密钥不能为空");
    expect(mocks.platformUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("纯空白字符串 apiKeys 同样返回 400（与创建端 POST trim 语义一致）", async () => {
    const { res } = await call("PUT", { apiKeys: "   " });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("API 密钥不能为空");
    expect(mocks.platformUpdate).not.toHaveBeenCalled();
  });

  it("部分有效密钥仍正常过滤落库（守卫不误伤）", async () => {
    const { res } = await call("PUT", {
      apiKeys: [{ key: "sk-valid-1" }, { key: " " }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mocks.platformUpdate).toHaveBeenCalledTimes(1);
    const dataArg = mocks.platformUpdate.mock.calls[0][0].data;
    expect(JSON.parse(dataArg.apiKeys)).toEqual([
      { name: "Key", key: "sk-valid-1" },
    ]);
  });
});

// ==================== PUT — rpmLimit/tpmLimit 整数校验（L13 回归） ====================

describe("PUT /api/admin/platforms/[id] — rpmLimit/tpmLimit 整数校验", () => {
  it("小数 rpmLimit 返回 400 且不落库（此前 Number.isFinite 放行小数导致 Prisma Int 列运行期 500，现与创建端 POST 同强度）", async () => {
    const { res } = await call("PUT", { rpmLimit: 1.5 });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("RPM 限制必须是非负整数");
    expect(mocks.platformUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

// ==================== GET — 明文密钥下发限流（L9） ====================

describe("GET /api/admin/platforms/[id] — 明文密钥下发限流", () => {
  it("限流命中时提前返回，不再查询与下发平台明文密钥", async () => {
    mocks.checkRateLimit.mockImplementation(async (_adminId, res) => {
      res.status(429).json({ success: false, error: "请求过于频繁" });
      return false;
    });
    const { res } = await call("GET");
    expect(res.statusCode).toBe(429);
    expect(mocks.platformFindFirst).not.toHaveBeenCalled();
  });
});