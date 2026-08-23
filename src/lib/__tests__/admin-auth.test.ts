/**
 * 管理员认证工具（src/lib/admin-auth.ts）单元测试
 *
 * 覆盖 getAdminFromRequest 双认证路径：
 * - Cookie+JWT：有效 / 过期 / 篡改 payload / 其他密钥签发 / 无 token
 * - Bearer system-api-key：有效 / 无效 Key / 被禁用 Key / JWT 优先于 Bearer
 * - JWT_SECRET 未配置时不抛错（返回 null，走 Bearer 分支）
 * - getAuditAdminId 归一化（system-key → null；env-admin 原样落库供审计归属）
 *
 * Bearer 分支走真实 PGlite 内存 PostgreSQL（system_api_keys 表），不 mock 数据库。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import type { NextApiRequest } from "next";
import { getAdminFromRequest, getAuditAdminId, type AuthResult } from "../admin-auth";
import { generateToken } from "../auth";
import { createTestDb, type TestDb } from "../../../lib/__tests__/helpers/test-pg-db";

// createDb() 无参调用时的环境检测（detectEnvironment）依赖 @opennextjs/cloudflare；
// 测试环境无 Cloudflare 上下文，mock 成抛错保证走 process.env 解析（DB_TYPE=pg → 命中
// PGlite 缓存），避免真实依赖在纯 Node 下的不确定行为（与 login-handler 一致）
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no Cloudflare context in test");
  },
}));

const JWT_SECRET = "test-secret-0123456789abcdef0123456789abcdef"; // 48 字符，≥ 32
const ADMIN_USERNAME = "admin";

let testDb: TestDb;
let savedPgUrl: string | undefined;
let savedDbType: string | undefined;

interface ReqLike {
  cookies?: Record<string, string>;
  headers?: Record<string, string | undefined>;
}

function makeReq(overrides: ReqLike = {}): NextApiRequest {
  return { cookies: {}, headers: {}, ...overrides } as unknown as NextApiRequest;
}

/** 用 jose 直接生成过期 token（expOffsetSec < 0 即已过期） */
async function makeExpiredToken(): Promise<string> {
  return new SignJWT({ adminId: "env-admin", username: ADMIN_USERNAME })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

/** 篡改 JWT payload（保留原签名，签名必然失配） */
function tamperPayload(token: string): string {
  const [h, , s] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ adminId: "attacker", username: "attacker" })
  ).toString("base64url");
  return `${h}.${forged}.${s}`;
}

beforeAll(async () => {
  testDb = await createTestDb();
  // 被测代码 validateSystemApiKey 内部调用无参 createDb()：显式固定方言与连接串
  // （参照 system-api-keys.test.ts 模式），不隐式依赖 .env.local 内容，保证命中
  // 本测试的虚拟库实例
  savedPgUrl = process.env.PG_URL;
  savedDbType = process.env.DB_TYPE;
  process.env.PG_URL = testDb.url;
  process.env.DB_TYPE = "pg";
  await testDb.db.systemApiKeys.create({
    data: {
      id: "sk-sys-id-1",
      key: "sk-system-test-key-1",
      name: "测试系统Key",
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
  });
  await testDb.db.systemApiKeys.create({
    data: {
      id: "sk-sys-id-2",
      key: "sk-system-disabled-key",
      name: "被禁用Key",
      enabled: false,
      createdAt: 0,
      updatedAt: 0,
    },
  });
}, 120_000);

afterAll(async () => {
  if (savedPgUrl === undefined) delete process.env.PG_URL;
  else process.env.PG_URL = savedPgUrl;
  if (savedDbType === undefined) delete process.env.DB_TYPE;
  else process.env.DB_TYPE = savedDbType;
  await testDb.cleanup();
});

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET;
});

afterEach(() => {
  delete process.env.JWT_SECRET;
});

describe("getAdminFromRequest — Cookie+JWT 路径", () => {
  it("有效 token 返回 jwt 认证结果", async () => {
    const token = await generateToken({ adminId: "env-admin", username: ADMIN_USERNAME }, { JWT_SECRET: JWT_SECRET });
    const result = await getAdminFromRequest(makeReq({ cookies: { admin_token: token } }));

    expect(result).toEqual({
      adminId: "env-admin",
      username: ADMIN_USERNAME,
      authMethod: "jwt",
    });
  });

  it("过期 token 返回 null（无 Bearer 可回退）", async () => {
    const result = await getAdminFromRequest(
      makeReq({ cookies: { admin_token: await makeExpiredToken() } })
    );
    expect(result).toBeNull();
  });

  it("篡改 payload（签名失配）返回 null", async () => {
    const token = await generateToken({ adminId: "env-admin", username: ADMIN_USERNAME }, { JWT_SECRET: JWT_SECRET });
    const result = await getAdminFromRequest(
      makeReq({ cookies: { admin_token: tamperPayload(token) } })
    );
    expect(result).toBeNull();
  });

  it("其他密钥签发的 token 返回 null", async () => {
    const token = await generateToken(
      { adminId: "env-admin", username: ADMIN_USERNAME },
      { JWT_SECRET: "another-secret-0123456789abcdef0123456789" }
    );
    const result = await getAdminFromRequest(makeReq({ cookies: { admin_token: token } }));
    expect(result).toBeNull();
  });

  it("无 Cookie 且无 Authorization 头返回 null", async () => {
    const result = await getAdminFromRequest(makeReq());
    expect(result).toBeNull();
  });

  it("JWT_SECRET 未配置时不抛错，返回 null", async () => {
    delete process.env.JWT_SECRET;
    const token = await generateToken({ adminId: "env-admin", username: ADMIN_USERNAME }, { JWT_SECRET: JWT_SECRET });
    const result = await getAdminFromRequest(makeReq({ cookies: { admin_token: token } }));
    expect(result).toBeNull();
  });
});

describe("getAdminFromRequest — Bearer system-api-key 路径", () => {
  it("有效系统 Key 返回 system-key 认证结果", async () => {
    const result = await getAdminFromRequest(
      makeReq({ headers: { authorization: "Bearer sk-system-test-key-1" } })
    );
    expect(result).toEqual({
      adminId: "sk-sys-id-1",
      username: "测试系统Key",
      authMethod: "system-key",
    });
  });

  it("无效 Key 返回 null", async () => {
    const result = await getAdminFromRequest(
      makeReq({ headers: { authorization: "Bearer sk-nonexistent-key" } })
    );
    expect(result).toBeNull();
  });

  it("被禁用的 Key 返回 null", async () => {
    const result = await getAdminFromRequest(
      makeReq({ headers: { authorization: "Bearer sk-system-disabled-key" } })
    );
    expect(result).toBeNull();
  });

  it("非 Bearer 前缀的 Authorization 头返回 null", async () => {
    const result = await getAdminFromRequest(
      makeReq({ headers: { authorization: "Basic dXNlcjpwYXNz" } })
    );
    expect(result).toBeNull();
  });

  it("Cookie JWT 与 Bearer 同时有效时优先 JWT", async () => {
    const token = await generateToken({ adminId: "env-admin", username: ADMIN_USERNAME }, { JWT_SECRET: JWT_SECRET });
    const result = await getAdminFromRequest(
      makeReq({
        cookies: { admin_token: token },
        headers: { authorization: "Bearer sk-system-test-key-1" },
      })
    );
    expect(result?.authMethod).toBe("jwt");
    expect(result?.adminId).toBe("env-admin");
  });
});

describe("getAuditAdminId — 虚拟 ID 归一化", () => {
  it("JWT env-admin（虚拟 ID）原样落库供审计页归属操作者", () => {
    const admin: AuthResult = { adminId: "env-admin", username: "admin", authMethod: "jwt" };
    expect(getAuditAdminId(admin)).toBe("env-admin");
  });

  it("system-key 认证返回 null", () => {
    const admin: AuthResult = {
      adminId: "sk-sys-id-1",
      username: "测试系统Key",
      authMethod: "system-key",
    };
    expect(getAuditAdminId(admin)).toBeNull();
  });

  it("JWT 非 env-admin（真实管理员 ID）原样返回", () => {
    const admin: AuthResult = { adminId: "real-admin-id", username: "admin", authMethod: "jwt" };
    expect(getAuditAdminId(admin)).toBe("real-admin-id");
  });
});
