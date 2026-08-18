/**
 * 预设平台一键创建 API（pages/api/admin/platforms/from-preset.ts）单元测试
 *
 * 覆盖（2026-08-18 审计 A7 回归）：
 * - 平台名含 & < > 时原样存库（此前 escapeHtml 存库导致显示为 HTML 实体
 *   AT&amp;T，且 PUT 不转义导致实体永久固化不可逆累积，与 platforms.ts POST
 *   / [id].ts PUT 路径一致不转义）
 * - name 缺省时使用预设名
 * - 预设模型批量写入与 type 推断
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-rate-limit、
 * @/lib/admin-security、@/lib/presets（detectModelType 使用真实实现）
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  platformCreate: vi.fn(),
  modelCreateMany: vi.fn(),
  auditCreate: vi.fn(),
  getDbKind: vi.fn(),
  getAdmin: vi.fn(),
  getAuditAdminId: vi.fn(),
  checkRateLimit: vi.fn(),
  isSafeUrl: vi.fn(),
  checkCsrfOrigin: vi.fn(),
  getPresetPlatform: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => {
    const db: any = {
      platforms: { create: mocks.platformCreate },
      platformModels: { createMany: mocks.modelCreateMany },
      auditLogs: { create: mocks.auditCreate },
    };
    // $transaction 直接透传执行（与 Prisma 语义等价，事务内使用同一 db）
    db.$transaction = async (fn: (tx: any) => Promise<void>) => fn(db);
    return db;
  }),
  getDbKind: mocks.getDbKind,
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
  getAuditAdminId: mocks.getAuditAdminId,
}));

vi.mock("@/lib/admin-rate-limit", () => ({
  checkAdminRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/lib/admin-security", () => ({
  isSafeUrl: mocks.isSafeUrl,
  checkCsrfOrigin: mocks.checkCsrfOrigin,
}));

vi.mock("@/lib/presets", () => ({
  getPresetPlatform: mocks.getPresetPlatform,
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/platforms/from-preset";

function makeReq(body: any = {}): NextApiRequest {
  return {
    method: "POST",
    headers: { host: "example.com" },
    body,
    cookies: {},
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

async function call(body: any = {}) {
  const req = makeReq(body);
  const res = makeRes();
  await handler(req, res);
  return { req, res: res as any };
}

const ADMIN = { adminId: "admin-1", username: "admin" };
const PRESET = {
  id: "openai",
  name: "OpenAI",
  type: "openai",
  baseUrl: "https://api.openai.com/v1",
  models: ["gpt-4o", "text-embedding-3-small"],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.getAuditAdminId.mockReturnValue("env-admin");
  mocks.checkRateLimit.mockResolvedValue(true);
  mocks.checkCsrfOrigin.mockReturnValue(true);
  mocks.isSafeUrl.mockResolvedValue({ safe: true, reason: "" });
  mocks.getDbKind.mockResolvedValue("pg");
  mocks.getPresetPlatform.mockImplementation((id: string) =>
    id === PRESET.id ? { ...PRESET } : null
  );
  mocks.platformCreate.mockResolvedValue({ id: "c1" });
  mocks.modelCreateMany.mockResolvedValue({ count: 2 });
  mocks.auditCreate.mockResolvedValue({});
});

// ==================== 创建平台 ====================

describe("POST /api/admin/platforms/from-preset", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call({ presetId: "openai" });
    expect(res.statusCode).toBe(401);
  });

  it("presetId 缺失返回 400", async () => {
    const { res } = await call({});
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("预设");
  });

  it("预设不存在返回 404", async () => {
    const { res } = await call({ presetId: "no-such" });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain("不存在");
  });

  it("平台名含 HTML 特殊字符时原样存库（A7 回归：无 escapeHtml）", async () => {
    // 回归：此前 escapeHtml(finalName) 存库，前端渲染自动转义后显示
    // "AT&amp;T"，详情页编辑保存（PUT 不转义）后实体永久固化不可逆累积
    const name = 'AT&T <Partner> "Quote" & Co';
    const { res } = await call({ presetId: "openai", name });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mocks.platformCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name }),
      })
    );
    expect(res.body.data.name).toBe(name);
  });

  it("name 缺省时使用预设默认名", async () => {
    const { res } = await call({ presetId: "openai" });
    expect(res.statusCode).toBe(200);
    expect(mocks.platformCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "OpenAI", presetId: "openai", type: "openai" }),
      })
    );
  });

  it("批量写入预设模型并按 ID 推断类型", async () => {
    const { res } = await call({ presetId: "openai" });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.modelCount).toBe(2);
    expect(mocks.modelCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ modelId: "gpt-4o", type: "chat", source: "manual" }),
          expect.objectContaining({ modelId: "text-embedding-3-small", type: "embedding" }),
        ]),
      })
    );
  });

  it("创建时写入审计日志", async () => {
    await call({ presetId: "openai" });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "create_platform",
          adminId: "env-admin",
        }),
      })
    );
  });
});