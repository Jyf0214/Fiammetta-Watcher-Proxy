/**
 * 登录认证链路回归测试（pages/api/admin/auth.ts）
 *
 * 背景：登录链路是本项目历史真实漏洞区（XFF 伪造绕过限流、共享桶 DoS、
 * KV TOCTOU、login CSRF 均于 2026-08-09 渗透测试确认），此前零测试覆盖。
 *
 * 覆盖分组：
 * - 登录成功：jose 验签 + payload 校验、Set-Cookie 属性、审计 login_success
 * - 登录失败：错误密码 / 用户不存在 401（错误消息一致，不泄露字段，时序防护行为面）
 * - 配置错误：JWT_SECRET 缺失 / 弱密钥 / 管理员未配置 → 500
 * - 请求格式：缺参 400、body 非对象 400、方法不允许 405
 * - DB 滑动窗口限流：5 次失败后 429 + resetAt、30 分钟窗口滑动、
 *   登录成功清除失败记录、IP 不可得 fail-open（不归入共享桶）
 * - 进程内内存限流兜底（append-only 语义）：DB 写入故障（fail-open）时
 *   内存计数仍限流（第 6 次 429）、DB 恢复后取 DB/内存较大者双向兜底、
 *   登录成功只清内存不清审计记录
 * - 并发突刺（TOCTOU 回归）：并发失败请求不产生 200，事后限流仍生效
 * - GET 当前管理员：无 token / 有效 / 过期 / 篡改 / 弱配置
 * - DELETE 登出：清 Cookie + 审计 logout
 *
 * 数据库使用 PGlite 内存 PostgreSQL（lib/__tests__/helpers/test-pg-db.ts）：
 * 审计日志与限流计数走真实 SQL，避免 mock 漂移掩盖回归。
 * 环境变量在 beforeEach/afterEach 中显式设置/清理，与 .env.local 隔离。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT, jwtVerify } from "jose";
import type { NextApiRequest, NextApiResponse } from "next";
import handler from "../../../pages/api/admin/auth";
import { createTestDb, type TestDb } from "../../../lib/__tests__/helpers/test-pg-db";

// createDb() 无参调用时的环境检测（detectEnvironment）依赖 @opennextjs/cloudflare；
// 测试环境无 Cloudflare 上下文，mock 成抛错保证走 process.env 解析（DB_TYPE=pg → 命中
// PGlite 缓存），避免真实依赖在纯 Node 下的不确定行为
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    throw new Error("no Cloudflare context in test");
  },
}));

// 数据库故障注入：failDb.enabled 时 createDb 抛错，模拟 DB 写入/查询失败。
// 用 importOriginal 透传原实现（beforeAll 的 createTestDb 与各用例的
// testDb 直接查询仍走真实 PGlite），仅被测 handler 的 createDb() 调用可被故障开关拦截
const { failDb } = vi.hoisted(() => ({ failDb: { enabled: false } }));
vi.mock("@/lib/prisma", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/prisma")>();
  return {
    ...mod,
    createDb: async (env?: Record<string, unknown> | { DB: unknown }) => {
      if (failDb.enabled) throw new Error("模拟数据库故障（进程内限流兜底测试）");
      return mod.createDb(env);
    },
  };
});

const JWT_SECRET = "test-secret-0123456789abcdef0123456789abcdef"; // 48 字符，≥ 32
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "correct-password-123";

/** 每个用例独立的模拟客户端 IP，避免限流/审计跨用例污染 */
const IP_SUCCESS = "203.0.113.10";
const IP_BAD_PASSWORD = "203.0.113.11";
const IP_BAD_USERNAME = "203.0.113.12";
const IP_RATE_LIMIT = "203.0.113.20";
const IP_WINDOW_OLD = "203.0.113.21";
const IP_CLEAR_ON_SUCCESS = "203.0.113.30";
const IP_NO_CLIENT = "203.0.113.40";
const IP_CONCURRENT = "203.0.113.77";
const IP_MEM_FALLBACK = "203.0.113.50"; // DB 故障期内存限流兜底
const IP_MEM_RECOVER = "203.0.113.51"; // DB 恢复后取 DB/内存较大者
const IP_DB_ONLY = "203.0.113.52"; // 内存为空仅 DB 有计数（重启等价场景）

let testDb: TestDb;
let savedPgUrl: string | undefined;
let savedDbType: string | undefined;

// ==================== 请求/响应 mock ====================

interface ReqLike {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  cookies?: Record<string, string>;
  socket?: { remoteAddress?: string };
}

function makeReq(overrides: ReqLike = {}): NextApiRequest {
  return {
    method: "POST",
    // 默认带同源 Origin（模拟浏览器请求）；login POST 的 CSRF 校验
    // （checkCsrfOrigin）在生产环境要求 POST 必须携带 Origin/Referer
    headers: { host: "example.com", origin: "http://example.com" },
    body: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    cookies: {},
    socket: { remoteAddress: IP_SUCCESS },
    ...overrides,
  } as unknown as NextApiRequest;
}

interface ResLike {
  headers: Record<string, string>;
  statusCode: number;
  body: unknown;
}

function makeRes(): ResLike & NextApiResponse {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown;
  const res: any = {
    headers,
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      body = b;
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k] = v;
      return res;
    },
    getHeader(k: string) {
      return headers[k];
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
  return res as ResLike & NextApiResponse;
}

async function callHandler(req: ReqLike): Promise<ResLike & NextApiResponse> {
  const res = makeRes();
  await handler(makeReq(req), res);
  return res;
}

/** 从 Set-Cookie 中提取 admin_token */
function extractToken(res: ResLike & NextApiResponse): string {
  const cookie = res.headers["Set-Cookie"];
  expect(cookie).toBeDefined();
  expect(cookie).toContain("admin_token=");
  const m = cookie!.match(/admin_token=([^;]+)/);
  expect(m).not.toBeNull();
  return m![1];
}

/** 生成 jose 签名的 admin JWT（expOffsetSec 为相对当前时间的过期偏移，负值即过期） */
async function makeToken(expOffsetSec: number, secret: string = JWT_SECRET): Promise<string> {
  return new SignJWT({ adminId: "env-admin", username: ADMIN_USERNAME })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expOffsetSec)
    .sign(new TextEncoder().encode(secret));
}

/** 篡改 JWT payload（保留原签名，签名必然失配） */
function tamperPayload(token: string): string {
  const [h, , s] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({ adminId: "attacker", username: "attacker" })
  ).toString("base64url");
  return `${h}.${forged}.${s}`;
}

async function countLoginFails(ip: string): Promise<number> {
  return testDb.db.auditLogs.count({ where: { action: "login_failed", ip } });
}

// ==================== 环境与数据库 ====================

beforeAll(async () => {
  testDb = await createTestDb();
  // 被测 handler 内部调用无参 createDb()：显式固定方言与连接串（参照
  // system-api-keys.test.ts 模式），不隐式依赖 .env.local 内容，保证其
  // 命中本测试的虚拟库实例
  savedPgUrl = process.env.PG_URL;
  savedDbType = process.env.DB_TYPE;
  process.env.PG_URL = testDb.url;
  process.env.DB_TYPE = "pg";
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
  process.env.ADMIN_USERNAME = ADMIN_USERNAME;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  delete process.env.ENVIRONMENT;
  delete process.env.DEPLOY_PLATFORM;
  delete process.env.TRUSTED_PROXY_IPS;
});

afterEach(() => {
  delete process.env.JWT_SECRET;
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.ENVIRONMENT;
  delete process.env.DEPLOY_PLATFORM;
  delete process.env.TRUSTED_PROXY_IPS;
});

// ==================== POST — 登录成功 ====================

describe("POST /api/admin/auth — 登录成功", () => {
  it("正确凭据签发 JWT（jose 验签 + payload）并设置 HttpOnly Cookie", async () => {
    const res = await callHandler({ socket: { remoteAddress: IP_SUCCESS } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { username: ADMIN_USERNAME } });

    // Cookie 属性：HttpOnly + SameSite=Lax + Path=/ + 7 天；非生产无 Secure
    const cookie = res.headers["Set-Cookie"];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    expect(cookie).not.toContain("Secure");

    // jose 独立验签：签名有效 + payload 正确
    const { payload } = await jwtVerify(
      extractToken(res),
      new TextEncoder().encode(JWT_SECRET),
      { algorithms: ["HS256"] }
    );
    expect(payload.adminId).toBe("env-admin");
    expect(payload.username).toBe(ADMIN_USERNAME);
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // 审计：login_success 写入（adminId=env-admin）
    const log = await testDb.db.auditLogs.findFirst({
      where: { action: "login_success", ip: IP_SUCCESS },
    });
    expect(log).not.toBeNull();
    expect(JSON.parse(log!.detail!)).toEqual({ username: ADMIN_USERNAME });
  });

  it("生产环境（ENVIRONMENT=production）Cookie 带 Secure", async () => {
    process.env.ENVIRONMENT = "production";
    const res = await callHandler({ socket: { remoteAddress: IP_SUCCESS } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Set-Cookie"]).toContain("Secure");
  });
});

// ==================== POST — 登录失败（401） ====================

describe("POST /api/admin/auth — 登录失败", () => {
  it("错误密码返回 401 + 审计 login_failed（adminId 为 null）", async () => {
    const res = await callHandler({
      socket: { remoteAddress: IP_BAD_PASSWORD },
      body: { username: ADMIN_USERNAME, password: "wrong-password" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: "用户名或密码错误" });
    expect(await countLoginFails(IP_BAD_PASSWORD)).toBe(1);

    const log = await testDb.db.auditLogs.findFirst({
      where: { action: "login_failed", ip: IP_BAD_PASSWORD },
    });
    expect(log!.adminId).toBeNull();
    expect(JSON.parse(log!.detail!)).toEqual({
      username: ADMIN_USERNAME,
      reason: "用户名或密码错误",
    });
  });

  it("用户不存在（错误用户名）返回 401，错误消息与密码错误完全一致（不泄露字段）", async () => {
    const wrongUser = await callHandler({
      socket: { remoteAddress: IP_BAD_USERNAME },
      body: { username: "nonexistent-user", password: ADMIN_PASSWORD },
    });
    const wrongPass = await callHandler({
      socket: { remoteAddress: IP_BAD_USERNAME },
      body: { username: ADMIN_USERNAME, password: "wrong-password" },
    });

    expect(wrongUser.statusCode).toBe(401);
    expect(wrongUser.body).toEqual(wrongPass.body);
    expect(wrongUser.body).toEqual({ success: false, error: "用户名或密码错误" });
    // 两种失败都写审计（用户名原样记录，供审计追踪）
    const usernames = await testDb.db.auditLogs.findMany({
      where: { action: "login_failed", ip: IP_BAD_USERNAME },
      select: { detail: true },
    });
    const details = usernames.map((l) => JSON.parse(l.detail!));
    expect(details).toContainEqual({
      username: "nonexistent-user",
      reason: "用户名或密码错误",
    });
  });

  it("用户名或密码缺失返回 400", async () => {
    const noPassword = await callHandler({
      socket: { remoteAddress: IP_BAD_USERNAME },
      body: { username: ADMIN_USERNAME },
    });
    expect(noPassword.statusCode).toBe(400);
    expect(noPassword.body).toEqual({ success: false, error: "用户名和密码不能为空" });

    const noUsername = await callHandler({
      socket: { remoteAddress: IP_BAD_USERNAME },
      body: { password: ADMIN_PASSWORD },
    });
    expect(noUsername.statusCode).toBe(400);
  });

  it("body 非对象返回 400", async () => {
    const res = await callHandler({
      socket: { remoteAddress: IP_BAD_USERNAME },
      body: "not-an-object",
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ success: false, error: "请求格式错误" });
  });

  it("超长用户名/密码（长度差异巨大）不抛错返回 401（常量时间比较长度分支）", async () => {
    // timingSafeStringEqual 对长度不同的输入走独立分支（不按长度提前短路返回），
    // 超长输入不得抛异常/500，且错误消息与常规失败完全一致（不泄露哪一字段错误）
    const res = await callHandler({
      socket: { remoteAddress: IP_BAD_USERNAME },
      body: { username: "u".repeat(4096), password: "p".repeat(4096) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: "用户名或密码错误" });
  });
});

// ==================== POST — 配置错误（500） ====================

describe("POST /api/admin/auth — 配置错误", () => {
  it("JWT_SECRET 未配置返回 500（通用文案，不泄露配置细节）", async () => {
    delete process.env.JWT_SECRET;
    const res = await callHandler({});
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: "服务器配置错误，请检查部署配置" });
  });

  it("JWT_SECRET 强度不足（< 32 字符）返回 500（通用文案）", async () => {
    process.env.JWT_SECRET = "short-secret";
    const res = await callHandler({});
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: "服务器配置错误，请检查部署配置",
    });
  });

  it("管理员账号未配置返回 500（通用文案）", async () => {
    delete process.env.ADMIN_PASSWORD;
    const res = await callHandler({});
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: "服务器配置错误，请检查部署配置",
    });
  });
});

// ==================== POST — DB 滑动窗口限流 ====================

describe("POST /api/admin/auth — DB 滑动窗口限流", () => {
  it("5 次失败后第 6 次请求 429（预检拦截）+ resetAt", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await callHandler({
        socket: { remoteAddress: IP_RATE_LIMIT },
        body: { username: ADMIN_USERNAME, password: "wrong-password" },
      });
      expect(res.statusCode).toBe(401);
    }

    const sixth = await callHandler({
      socket: { remoteAddress: IP_RATE_LIMIT },
      body: { username: ADMIN_USERNAME, password: "wrong-password" },
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.body).toMatchObject({
      success: false,
      error: "登录尝试次数过多（5 次/30 分钟），请稍后再试",
    });
    // 文案由 LOGIN_MAX_ATTEMPTS/LOGIN_WINDOW_MS 模板插值生成，断言模板
    // 形态而非固定常量：将来调整限流参数时测试不会因"碰巧一致"静默变红
    expect(String((sixth.body as { error: string }).error)).toMatch(
      /^登录尝试次数过多（\d+ 次\/\d+ 分钟），请稍后再试$/
    );
    const resetAt = (sixth.body as { resetAt: string }).resetAt;
    expect(typeof resetAt).toBe("string");
    expect(Date.parse(resetAt)).toBeGreaterThan(Date.now());

    // 预检不写库：计数保持 5
    expect(await countLoginFails(IP_RATE_LIMIT)).toBe(5);
  });

  it("30 分钟窗口滑动：窗口外旧失败记录不参与计数", async () => {
    const now = Math.floor(Date.now() / 1000);
    // 直接插入 5 条窗口外（31 分钟前）的失败记录
    await testDb.db.auditLogs.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        id: crypto.randomUUID(),
        adminId: null,
        action: "login_failed",
        detail: JSON.stringify({ username: "old", reason: "旧记录" }),
        ip: IP_WINDOW_OLD,
        createdAt: now - 31 * 60 - i,
      })),
    });

    const res = await callHandler({
      socket: { remoteAddress: IP_WINDOW_OLD },
      body: { username: ADMIN_USERNAME, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401); // 未超限
    expect(await countLoginFails(IP_WINDOW_OLD)).toBe(6); // 5 旧 + 1 新
  });

  it("登录成功不删除失败审计记录（append-only），进程内计数归零", async () => {
    for (let i = 0; i < 3; i++) {
      await callHandler({
        socket: { remoteAddress: IP_CLEAR_ON_SUCCESS },
        body: { username: ADMIN_USERNAME, password: "wrong-password" },
      });
    }
    expect(await countLoginFails(IP_CLEAR_ON_SUCCESS)).toBe(3);

    const ok = await callHandler({ socket: { remoteAddress: IP_CLEAR_ON_SUCCESS } });
    expect(ok.statusCode).toBe(200);
    // 审计 append-only：login_failed 记录不再被 deleteMany 物理删除
    // （历史 bug：把审计表当计数表复用，成功登录后审计记录丢失）
    expect(await countLoginFails(IP_CLEAR_ON_SUCCESS)).toBe(3);

    // 进程内计数已清空，DB 窗口内 3+1=4 ≤ 5：再次失败不触发限流
    const again = await callHandler({
      socket: { remoteAddress: IP_CLEAR_ON_SUCCESS },
      body: { username: ADMIN_USERNAME, password: "wrong-password" },
    });
    expect(again.statusCode).toBe(401);
  });

  it("IP 不可得（无 socket 且无边缘头）时跳过限流并审计 unknown（不归入共享桶）", async () => {
    const res = await callHandler({
      socket: {},
      headers: {},
      body: { username: ADMIN_USERNAME, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);

    const log = await testDb.db.auditLogs.findFirst({
      where: { action: "login_failed", ip: "unknown" },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
  });
});

// ==================== POST — 进程内内存限流（DB 故障兜底） ====================

describe("POST /api/admin/auth — 进程内内存限流（DB 故障兜底）", () => {
  it("DB 写入失败（fail-open）时不 500：前 5 次仍 401，第 6 次起内存计数拦截 429", async () => {
    failDb.enabled = true;
    try {
      for (let i = 0; i < 5; i++) {
        const res = await callHandler({
          socket: { remoteAddress: IP_MEM_FALLBACK },
          body: { username: ADMIN_USERNAME, password: "wrong-password" },
        });
        // fail-open：DB 故障期间失败请求仍返回 401（限流是防滥用而非安全边界），
        // 不因审计写入异常升级为 500；每次失败仍计入进程内窗口
        expect(res.statusCode).toBe(401);
      }

      // 内存滑动窗口已积累 5 次：预检（readDbLoginFailInfo 的 DB 异常兜底分支）
      // 直接以进程内计数拦截，无需 DB
      const sixth = await callHandler({
        socket: { remoteAddress: IP_MEM_FALLBACK },
        body: { username: ADMIN_USERNAME, password: "wrong-password" },
      });
      expect(sixth.statusCode).toBe(429);
      expect(sixth.body).toMatchObject({
        success: false,
        error: "登录尝试次数过多（5 次/30 分钟），请稍后再试",
      });

      // 故障期间审计零写入（writeAuditLog 在 createDb 处即抛错）：
      // 计数完全由进程内窗口承担
      expect(await countLoginFails(IP_MEM_FALLBACK)).toBe(0);
    } finally {
      failDb.enabled = false;
    }
  });

  it("DB 恢复后计数取 DB 与内存较大者：内存 5 次而 DB 零记录仍拦截 429", async () => {
    failDb.enabled = true;
    try {
      for (let i = 0; i < 5; i++) {
        await callHandler({
          socket: { remoteAddress: IP_MEM_RECOVER },
          body: { username: ADMIN_USERNAME, password: "wrong-password" },
        });
      }
    } finally {
      failDb.enabled = false;
    }
    expect(await countLoginFails(IP_MEM_RECOVER)).toBe(0);

    // DB 已恢复但本进程内存窗口仍记 5 次：预检取 max(DB=0, 内存=5) 拦截——
    // 证明"进程重启后内存丢失由 DB 兜底、DB 故障时由内存兜底"的双向兜底中，
    // 内存侧单独即可限流，且预检拦截不写库
    const res = await callHandler({
      socket: { remoteAddress: IP_MEM_RECOVER },
      body: { username: ADMIN_USERNAME, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(429);
    expect(await countLoginFails(IP_MEM_RECOVER)).toBe(0);
  });

  it("进程重启等价场景：DB 有 5 条窗口内记录而内存为空时，预检仍 429（DB 兜底）", async () => {
    // 直接种入 5 条窗口内 login_failed 记录（模拟进程重启后内存丢失、仅剩
    // DB 持久化计数；handler 未参与，进程内窗口为空）——取较大者时 DB 侧兜底
    await testDb.db.auditLogs.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        id: crypto.randomUUID(),
        adminId: null,
        action: "login_failed",
        detail: JSON.stringify({ username: "legacy", reason: "重启前遗留" }),
        ip: IP_DB_ONLY,
        createdAt: Math.floor(Date.now() / 1000) - i,
      })),
    });

    const res = await callHandler({
      socket: { remoteAddress: IP_DB_ONLY },
      body: { username: ADMIN_USERNAME, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(429);
    expect((res.body as { resetAt?: string }).resetAt).toBeDefined();
    // 预检拦截不写库：仍 5 条
    expect(await countLoginFails(IP_DB_ONLY)).toBe(5);
  });
});

// ==================== POST — 并发突刺（TOCTOU 回归） ====================

describe("POST /api/admin/auth — 并发突刺（TOCTOU 回归）", () => {
  it("8 个并发失败请求无 200（写后计数不产生绕过窗口），事后限流仍生效", async () => {
    const reqs = Array.from({ length: 8 }, () => ({
      socket: { remoteAddress: IP_CONCURRENT },
      body: { username: ADMIN_USERNAME, password: "wrong-password" },
    }));

    const results = await Promise.all(
      reqs.map(async (r) => {
        const res = makeRes();
        await handler(makeReq(r), res);
        return res;
      })
    );

    // 核心回归断言：并发突刺下没有任何请求拿到 200（无 TOCTOU 绕过）
    for (const res of results) {
      expect(res.statusCode).not.toBe(200);
      expect(res.statusCode).toBeGreaterThanOrEqual(401);
    }
    // 并发下"先写后查"保证至少有请求被 429 拦截（写后计数生效）
    expect(results.some((r) => r.statusCode === 429)).toBe(true);

    // 每条失败记录都已落库
    expect(await countLoginFails(IP_CONCURRENT)).toBe(8);

    // 事后限流仍生效：新请求被预检 429
    const next = await callHandler({
      socket: { remoteAddress: IP_CONCURRENT },
      body: { username: ADMIN_USERNAME, password: "wrong-password" },
    });
    expect(next.statusCode).toBe(429);
  });
});

// ==================== GET — 当前管理员 ====================

describe("GET /api/admin/auth — 获取当前管理员", () => {
  it("无 Cookie 返回 401", async () => {
    const res = await callHandler({ method: "GET" });
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ success: false, error: "未授权" });
  });

  it("有效 token 返回管理员信息", async () => {
    const token = await makeToken(3600);
    const res = await callHandler({
      method: "GET",
      headers: { cookie: `admin_token=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { adminId: "env-admin", username: ADMIN_USERNAME },
    });
  });

  it("过期 token 返回 401", async () => {
    const token = await makeToken(-3600);
    const res = await callHandler({
      method: "GET",
      headers: { cookie: `admin_token=${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("篡改 token（payload 被改、签名失配）返回 401", async () => {
    const token = tamperPayload(await makeToken(3600));
    const res = await callHandler({
      method: "GET",
      headers: { cookie: `admin_token=${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("其他密钥签发的 token 返回 401", async () => {
    const token = await makeToken(3600, "another-secret-0123456789abcdef0123456789");
    const res = await callHandler({
      method: "GET",
      headers: { cookie: `admin_token=${token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("JWT_SECRET 未配置返回 500（通用文案）", async () => {
    delete process.env.JWT_SECRET;
    const res = await callHandler({ method: "GET" });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, error: "服务器配置错误，请检查部署配置" });
  });
});

// ==================== DELETE — 登出 ====================

describe("DELETE /api/admin/auth — 登出", () => {
  it("带有效 Cookie 登出：清除 Cookie + 审计 logout", async () => {
    const token = await makeToken(3600);
    const res = await callHandler({
      method: "DELETE",
      headers: { cookie: `admin_token=${token}` },
      socket: { remoteAddress: IP_SUCCESS },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, message: "已退出登录" });

    const cookie = res.headers["Set-Cookie"];
    expect(cookie).toContain("admin_token=");
    expect(cookie).toContain("Max-Age=0");

    const log = await testDb.db.auditLogs.findFirst({
      where: { action: "logout", ip: IP_SUCCESS },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
    expect(JSON.parse(log!.detail!)).toEqual({ username: ADMIN_USERNAME });
    // env-admin 为虚拟 ID，不落 adminId（兼容早期外键方言）
    expect(log!.adminId).toBeNull();
  });

  it("无 Cookie 登出：仍返回 200 并清除 Cookie，不写审计", async () => {
    const res = await callHandler({ method: "DELETE", socket: { remoteAddress: IP_NO_CLIENT } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Set-Cookie"]).toContain("Max-Age=0");
    // 无 token 时不写审计（此前用例已写入 logout 记录，按 IP 隔离断言）
    const logoutCount = await testDb.db.auditLogs.count({
      where: { action: "logout", ip: IP_NO_CLIENT },
    });
    expect(logoutCount).toBe(0);
  });
});

// ==================== 其他 ====================

describe("handler — 方法分发", () => {
  it("不允许的方法返回 405 + Allow 头", async () => {
    const res = await callHandler({ method: "PUT" });
    expect(res.statusCode).toBe(405);
    expect(res.headers["Allow"]).toEqual(["GET", "POST", "DELETE"]);
    expect(res.body).toEqual({ success: false, error: "Method not allowed" });
  });
});
