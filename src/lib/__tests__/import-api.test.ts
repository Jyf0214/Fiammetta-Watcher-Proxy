/**
 * 数据导入 API（pages/api/admin/import.ts）单元测试
 *
 * 覆盖（2026-08-18 审计 A3 回归）：
 * - API Key 导入时 status 枚举白名单：expired 保留（此前缺 "expired" 回退
 *   "active"，手动标记过期的 Key 在迁移/备份恢复后复活可用）；
 *   disabled 保留；白名单外未知状态回退 "active"
 *
 * 使用 NDJSON 流式响应：mock res 捕获 write 片段，解析 complete 事件断言导入结果。
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-rate-limit、@/lib/admin-security
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  apiKeyFindMany: vi.fn(),
  apiKeyCreateMany: vi.fn(),
  auditCreate: vi.fn(),
  getAdmin: vi.fn(),
  getAuditAdminId: vi.fn(),
  checkRateLimit: vi.fn(),
  checkCsrfOrigin: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    apiKeys: {
      findMany: mocks.apiKeyFindMany,
      createMany: mocks.apiKeyCreateMany,
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

vi.mock("@/lib/admin-rate-limit", () => ({
  checkAdminRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/admin-security", () => ({
  isSafeUrl: vi.fn(async () => ({ safe: true, reason: "" })),
  checkCsrfOrigin: mocks.checkCsrfOrigin,
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/import";

function makeReq(body: any = {}): NextApiRequest {
  return {
    method: "POST",
    headers: { host: "example.com" },
    body,
    cookies: {},
  } as unknown as NextApiRequest;
}

/** NDJSON 流式响应 mock：收集 write 片段，可取最后完整事件 */
function makeRes() {
  const chunks: string[] = [];
  let statusCode = 200;
  const res: any = {
    chunks,
    status(c: number) { statusCode = c; return res; },
    json() { return res; },
    setHeader() { return res; },
    write(chunk: string) { chunks.push(chunk); return true; },
    end() { return res; },
    get headersSent() { return false; },
    get statusCode() { return statusCode; },
  };
  return res;
}

function lastEvent(res: any): Record<string, any> {
  const lines = res.chunks.join("").trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

/** 构造合法的导入请求体（仅含 apiKeys，其他类型不触发对应导入步骤） */
function makeImportBody(apiKeys: Array<Record<string, unknown>>) {
  return { version: "1", exportedAt: "2026-08-18T00:00:00.000Z", apiKeys };
}

const ADMIN = { adminId: "admin-1", username: "admin" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.getAuditAdminId.mockReturnValue("env-admin");
  mocks.checkRateLimit.mockResolvedValue(true);
  mocks.checkCsrfOrigin.mockReturnValue(true);
  // 两次 findMany：select key 去重集合 + select id 保留原始 id 集合，均无已有记录
  mocks.apiKeyFindMany.mockResolvedValue([]);
  mocks.apiKeyCreateMany.mockImplementation(async ({ data }: any) => ({ count: data.length }));
  mocks.auditCreate.mockResolvedValue({});
});

// ==================== API Key 导入 — status 白名单 ====================

describe("POST /api/admin/import — apiKeys status 枚举", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const res = makeRes();
    await handler(makeReq(makeImportBody([])), res);
    expect(res.statusCode).toBe(401);
  });

  it("expired 状态保留（此前缺白名单回退 active 复活）", async () => {
    const body = makeImportBody([
      { id: "k1", key: "sk-expired-1", name: "过期 Key", status: "expired", resetPeriod: "monthly" },
    ]);
    const res = makeRes();
    await handler(makeReq(body), res);
    expect(mocks.apiKeyCreateMany).toHaveBeenCalledTimes(1);
    const callData = mocks.apiKeyCreateMany.mock.calls[0][0].data;
    expect(callData[0].status).toBe("expired");
    // complete 事件确认导入成功
    const event = lastEvent(res);
    expect(event.type).toBe("complete");
    expect(event.details.apiKeys.imported).toBe(1);
  });

  it("disabled 状态保留", async () => {
    const body = makeImportBody([
      { id: "k2", key: "sk-disabled-1", name: "禁用 Key", status: "disabled", resetPeriod: "never" },
    ]);
    const res = makeRes();
    await handler(makeReq(body), res);
    const callData = mocks.apiKeyCreateMany.mock.calls[0][0].data;
    expect(callData[0].status).toBe("disabled");
  });

  it("白名单外未知状态回退 active", async () => {
    const body = makeImportBody([
      { id: "k3", key: "sk-unknown-1", name: "未知状态 Key", status: "suspended", resetPeriod: "daily" },
    ]);
    const res = makeRes();
    await handler(makeReq(body), res);
    const callData = mocks.apiKeyCreateMany.mock.calls[0][0].data;
    expect(callData[0].status).toBe("active");
  });

  it("混合状态一次导入各自按枚举保留/回退", async () => {
    const body = makeImportBody([
      { id: "k1", key: "sk-expired-1", status: "expired", resetPeriod: "monthly" },
      { id: "k2", key: "sk-active-1", status: "active", resetPeriod: "monthly" },
      { id: "k3", key: "sk-weird-1", status: "weird", resetPeriod: "monthly" },
    ]);
    const res = makeRes();
    await handler(makeReq(body), res);
    const callData = mocks.apiKeyCreateMany.mock.calls[0][0].data;
    expect(callData.map((r: any) => [r.key, r.status])).toEqual([
      ["sk-expired-1", "expired"],
      ["sk-active-1", "active"],
      ["sk-weird-1", "active"],
    ]);
  });
});