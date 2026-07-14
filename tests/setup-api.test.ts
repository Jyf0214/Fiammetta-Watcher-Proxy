import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "../src/app/api/setup/configure/route";
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

// Mock execSync 阻止实际的 prisma db push 执行
vi.mock("child_process", () => ({
  execSync: vi.fn(() => Buffer.from("")),
}));

// Mock initializeAdmin 阻止实际的管理员初始化
vi.mock("@/services/init", () => ({
  initializeAdmin: vi.fn(() => Promise.resolve()),
}));

// 测试用临时目录
const TEST_DATA_DIR = "tmp/test-api-config";

/**
 * 创建模拟的 Request 对象
 */
function createMockRequest(body: unknown): Request {
  return new Request("http://localhost/api/setup/configure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * 解析响应 JSON
 */
async function parseResponse(response: Response) {
  return response.json();
}

describe("Setup API - POST /api/setup/configure", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 清理测试目录
    const testDir = join(process.cwd(), TEST_DATA_DIR);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });

    // 清除环境变量
    delete process.env.DATABASE_URL;
    delete process.env.JWKS_KEY;
    delete process.env.DATA_DIR;

    // 设置 DATA_DIR 指向测试目录
    process.env.DATA_DIR = TEST_DATA_DIR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    // 清理测试目录
    const testDir = join(process.cwd(), TEST_DATA_DIR);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe("参数验证", () => {
    it("缺少 DATABASE_URL 应返回 400", async () => {
      const request = createMockRequest({
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
      });
      const response = await POST(request);
      const data = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error).toContain("缺少必需的配置字段");
    });

    it("缺少 ADMIN_USERNAME 应返回 400", async () => {
      const request = createMockRequest({
        DATABASE_URL: "postgresql://user:pass@localhost/db",
        ADMIN_PASSWORD: "password123",
      });
      const response = await POST(request);
      const result = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(result.success).toBe(false);
    });

    it("缺少 ADMIN_PASSWORD 应返回 400", async () => {
      const request = createMockRequest({
        DATABASE_URL: "postgresql://user:pass@localhost/db",
        ADMIN_USERNAME: "admin",
      });
      const response = await POST(request);
      const result = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(result.success).toBe(false);
    });

    it("无效的 DATABASE_URL 格式应返回 400", async () => {
      const request = createMockRequest({
        DATABASE_URL: "ftp://invalid-protocol.com/db",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
      });
      const response = await POST(request);
      const data = await parseResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toContain("数据库 URL 格式无效");
    });

    it("不支持的数据库协议应返回 400", async () => {
      const request = createMockRequest({
        DATABASE_URL: "mongodb://user:pass@localhost/db",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe("正常配置", () => {
    it("有效的 PostgreSQL 配置应返回成功", async () => {
      const request = createMockRequest({
        DATABASE_URL: "postgresql://user:pass@localhost:5432/testdb",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
      });
      const response = await POST(request);
      const data = await parseResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.message).toContain("db-config.json");
    });

    it("有效的 MySQL 配置应返回成功", async () => {
      const request = createMockRequest({
        DATABASE_URL: "mysql://root:password@mysql-host:3306/mydb",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
      });
      const response = await POST(request);
      const data = await parseResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("postgres:// 协议应该被接受", async () => {
      const request = createMockRequest({
        DATABASE_URL: "postgres://user:pass@localhost/db",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
      });
      const response = await POST(request);
      const data = await parseResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("密码包含特殊字符应该正确处理", async () => {
      const request = createMockRequest({
        DATABASE_URL: "postgresql://user:p@ss!w0rd@localhost/db",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
      });
      const response = await POST(request);
      const data = await parseResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("配置应该写入文件", async () => {
      const request = createMockRequest({
        DATABASE_URL: "postgresql://user:pass@localhost:5432/testdb",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
      });
      await POST(request);

      const configPath = join(
        process.cwd(),
        TEST_DATA_DIR,
        "db-config.json"
      );
      expect(existsSync(configPath)).toBe(true);

      const content = readFileSync(configPath, "utf-8");
      const config = JSON.parse(content);
      expect(config.type).toBe("postgresql");
      expect(config.hostname).toBe("localhost");
      expect(config.port).toBe(5432);
      expect(config.dbName).toBe("testdb");
      expect(config.username).toBe("user");
      expect(config.password).toBe("pass");
    });

    it("响应不应该包含数据库密码", async () => {
      const request = createMockRequest({
        DATABASE_URL: "postgresql://user:secretpassword@localhost/db",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
      });
      const response = await POST(request);
      const data = await parseResponse(response);

      expect(JSON.stringify(data)).not.toContain("secretpassword");
    });
  });

  describe("JWKS_KEY 支持", () => {
    it("JWKS_KEY 应该保存到配置文件", async () => {
      const jwksKey = '{"keys":[{"kty":"RSA","d":"test"}]}';
      const request = createMockRequest({
        DATABASE_URL: "postgresql://user:pass@localhost/db",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
        JWKS_KEY: jwksKey,
      });
      const response = await POST(request);
      const data = await parseResponse(response);

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // 验证 JWKS_KEY 写入文件
      const configPath = join(
        process.cwd(),
        TEST_DATA_DIR,
        "db-config.json"
      );
      const content = readFileSync(configPath, "utf-8");
      const config = JSON.parse(content);
      expect(config.jwksKey).toBe(jwksKey);
    });

    it("不提供 JWKS_KEY 时配置文件不应包含该字段", async () => {
      const request = createMockRequest({
        DATABASE_URL: "postgresql://user:pass@localhost/db",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
      });
      await POST(request);

      const configPath = join(
        process.cwd(),
        TEST_DATA_DIR,
        "db-config.json"
      );
      const content = readFileSync(configPath, "utf-8");
      const config = JSON.parse(content);
      expect(config.jwksKey).toBeUndefined();
    });
  });

  describe("重复配置保护", () => {
    it("已有 DATABASE_URL 环境变量时应返回 403", async () => {
      process.env.DATABASE_URL = "postgresql://existing:existing@localhost/existing";

      const request = createMockRequest({
        DATABASE_URL: "postgresql://user:pass@localhost/newdb",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
      });
      const response = await POST(request);
      const data = await parseResponse(response);

      expect(response.status).toBe(403);
      expect(data.success).toBe(false);
      expect(data.error).toContain("不允许通过 API 修改");
    });
  });

  describe("响应格式", () => {
    it("成功响应应该包含正确的字段", async () => {
      const request = createMockRequest({
        DATABASE_URL: "postgresql://user:pass@localhost/db",
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "password123",
      });
      const response = await POST(request);
      const data = await parseResponse(response);

      expect(data).toHaveProperty("success");
      expect(data).toHaveProperty("message");
      expect(data).toHaveProperty("data");
      expect(data.data).toHaveProperty("adminUsername");
      expect(data.data).toHaveProperty("savedToConfigFile");
      expect(data.data.savedToConfigFile).toBe(true);
    });

    it("失败响应应该包含错误信息", async () => {
      const request = createMockRequest({
        DATABASE_URL: "invalid-url",
      });
      const response = await POST(request);
      const data = await parseResponse(response);

      expect(data).toHaveProperty("success");
      expect(data).toHaveProperty("error");
      expect(data.success).toBe(false);
    });
  });
});
