/**
 * 平台模型管理 API（pages/api/admin/platforms/[id]/models.ts）单元测试
 *
 * 覆盖（2026-08-17 审计修复回归）：
 * - POST 手动添加模型：type 由 detectModelType 推断（此前硬编码 "chat"，
 *   embedding/image 等模型被归错分类），与刷新路径一致
 * - PATCH 单模型启停：模型不存在时 updateMany count 为 0 → 404
 *   （此前不检查 count 返回假成功）
 *
 * Mock 外部依赖：@/lib/prisma、@/lib/admin-auth、@/lib/admin-security、
 * @/lib/upstream-proxy（detectModelType 使用真实实现）
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextApiRequest, NextApiResponse } from "next";

// ==================== Mocks ====================

const mocks = vi.hoisted(() => ({
  platformFindFirst: vi.fn(),
  modelFindFirst: vi.fn(),
  modelCreate: vi.fn(),
  modelUpdateMany: vi.fn(),
  getDbKind: vi.fn(),
  getAdmin: vi.fn(),
  checkCsrfOrigin: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  createDb: vi.fn(async () => ({
    platforms: {
      findFirst: mocks.platformFindFirst,
    },
    platformModels: {
      findFirst: mocks.modelFindFirst,
      create: mocks.modelCreate,
      updateMany: mocks.modelUpdateMany,
    },
  })),
  getDbKind: mocks.getDbKind,
}));

vi.mock("@/lib/admin-auth", () => ({
  getAdminFromRequest: mocks.getAdmin,
}));

vi.mock("@/lib/admin-security", () => ({
  checkCsrfOrigin: mocks.checkCsrfOrigin,
  isSafeUrl: vi.fn(async () => ({ safe: true, reason: "" })),
}));

vi.mock("@/lib/upstream-proxy", () => ({
  getUpstreamProxy: vi.fn(async () => ({ url: null, dispatcher: null })),
  markProxyFailure: vi.fn(async () => {}),
}));

// ==================== Helpers ====================

import handler from "../../../pages/api/admin/platforms/[id]/models";

function makeReq(overrides: any = {}): NextApiRequest {
  return {
    method: "GET",
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
const PLATFORM = { id: "p1", name: "OpenAI", apiKeys: "[]", baseUrl: "https://api.openai.com/v1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAdmin.mockResolvedValue(ADMIN);
  mocks.checkCsrfOrigin.mockReturnValue(true);
  mocks.getDbKind.mockResolvedValue("pg");
  mocks.platformFindFirst.mockResolvedValue(PLATFORM);
  mocks.modelFindFirst.mockResolvedValue(null);
  mocks.modelCreate.mockResolvedValue({ id: "m1" });
  mocks.modelUpdateMany.mockResolvedValue({ count: 1 });
});

// ==================== POST — 手动添加模型 ====================

describe("POST /api/admin/platforms/:id/models", () => {
  it("未认证返回 401", async () => {
    mocks.getAdmin.mockResolvedValue(null);
    const { res } = await call("POST", { modelId: "gpt-4o" });
    expect(res.statusCode).toBe(401);
  });

  it("modelId 为空返回 400", async () => {
    const { res } = await call("POST", { modelId: "  " });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("模型 ID");
  });

  it("平台不存在返回 404", async () => {
    mocks.platformFindFirst.mockResolvedValue(null);
    const { res } = await call("POST", { modelId: "gpt-4o" });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain("平台不存在");
  });

  it("模型已存在返回 400", async () => {
    mocks.modelFindFirst.mockResolvedValue({ id: "existing" });
    const { res } = await call("POST", { modelId: "gpt-4o" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("已存在");
  });

  it("embedding 模型 type 推断为 embedding（此前硬编码 chat）", async () => {
    const { res } = await call("POST", { modelId: "text-embedding-3-small" });
    expect(res.statusCode).toBe(200);
    expect(mocks.modelCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelId: "text-embedding-3-small",
          type: "embedding",
          source: "manual",
        }),
      })
    );
  });

  it("普通 chat 模型 type 推断为 chat", async () => {
    await call("POST", { modelId: "gpt-4o" });
    expect(mocks.modelCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: "chat" }),
      })
    );
  });

  it("modelId 去除首尾空白后参与推断与入库", async () => {
    await call("POST", { modelId: "  text-embedding-3-small  " });
    expect(mocks.modelCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          modelId: "text-embedding-3-small",
          modelName: "text-embedding-3-small",
          type: "embedding",
        }),
      })
    );
  });
});

// ==================== PATCH — 模型启停 ====================

describe("PATCH /api/admin/platforms/:id/models", () => {
  it("缺少 enabled 返回 400", async () => {
    const { res } = await call("PATCH", { modelId: "gpt-4o" });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("enabled");
  });

  it("单模型不存在时 updateMany count=0 返回 404（此前假成功）", async () => {
    mocks.modelUpdateMany.mockResolvedValue({ count: 0 });
    const { res } = await call("PATCH", { modelId: "no-such-model", enabled: true });
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toContain("模型不存在");
    // 404 时不返回成功消息
    expect(res.body.success).toBe(false);
  });

  it("单模型存在时返回启用成功", async () => {
    const { res } = await call("PATCH", { modelId: "gpt-4o", enabled: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe("模型已启用");
    expect(mocks.modelUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { platformId: "p1", modelId: "gpt-4o" },
        data: { enabled: true },
      })
    );
  });

  it("单模型禁用成功", async () => {
    const { res } = await call("PATCH", { modelId: "gpt-4o", enabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe("模型已禁用");
  });

  it("无 modelId 时批量切换全部模型并返回受影响数量", async () => {
    mocks.modelUpdateMany.mockResolvedValue({ count: 3 });
    const { res } = await call("PATCH", { enabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toContain("3");
    expect(res.body.data.affected).toBe(3);
  });
});