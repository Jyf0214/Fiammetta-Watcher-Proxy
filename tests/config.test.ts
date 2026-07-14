import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readDbConfig,
  saveDbConfig,
  isDatabaseConfigured,
  getDatabaseUrl,
  configToDatabaseUrl,
  loadConfigFromEnv,
} from "../src/lib/config";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

// 测试用临时目录（使用相对路径，让 config 模块正确解析）
const TEST_DATA_DIR = "tmp/test-config";

// 有效配置样本
const validConfig = {
  type: "postgresql" as const,
  hostname: "db.example.com",
  port: 5432,
  dbName: "testdb",
  username: "testuser",
  password: "p@ssw0rd!#",
  ssl: true,
};

const mysqlConfig = {
  type: "mysql" as const,
  hostname: "mysql.example.com",
  port: 3306,
  dbName: "mysqldb",
  username: "root",
  password: "mysqlpass",
};

describe("config 模块", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 清理测试目录
    const testDir = join(process.cwd(), TEST_DATA_DIR);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(testDir, { recursive: true });

    // 清除相关环境变量
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

  describe("saveDbConfig", () => {
    it("应该成功保存配置到文件", () => {
      const result = saveDbConfig(validConfig);
      expect(result).toBe(true);
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      expect(existsSync(configPath)).toBe(true);
    });

    it("应该保存有效的 JSON 格式", () => {
      saveDbConfig(validConfig);
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      const content = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(validConfig);
    });

    it("应该保存 MySQL 配置", () => {
      saveDbConfig(mysqlConfig);
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      const content = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.type).toBe("mysql");
      expect(parsed.port).toBe(3306);
    });

    it("应该在目录不存在时自动创建目录", () => {
      const newDir = "tmp/new-config-test";
      const newDirFull = join(process.cwd(), newDir);
      if (existsSync(newDirFull)) {
        rmSync(newDirFull, { recursive: true });
      }
      process.env.DATA_DIR = newDir;
      const result = saveDbConfig(validConfig);
      expect(result).toBe(true);
      expect(existsSync(join(newDirFull, "db-config.json"))).toBe(true);
      rmSync(newDirFull, { recursive: true });
    });

    it("包含 jwksKey 的配置应该正确保存", () => {
      const configWithJwks = {
        ...validConfig,
        jwksKey: '{"keys":[{"kty":"RSA","d":"test"}]}',
      };
      saveDbConfig(configWithJwks);
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      const content = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.jwksKey).toBe('{"keys":[{"kty":"RSA","d":"test"}]}');
    });
  });

  describe("readDbConfig", () => {
    it("配置文件不存在时返回 null", () => {
      // 不写入任何文件，确保目录是空的
      const result = readDbConfig();
      expect(result).toBeNull();
    });

    it("应该读取有效配置", () => {
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      writeFileSync(configPath, JSON.stringify(validConfig), "utf-8");
      const result = readDbConfig();
      expect(result).toEqual(validConfig);
    });

    it("应该读取包含 jwksKey 的配置", () => {
      const configWithJwks = { ...validConfig, jwksKey: "test-jwks-key" };
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      writeFileSync(configPath, JSON.stringify(configWithJwks), "utf-8");
      const result = readDbConfig();
      expect(result?.jwksKey).toBe("test-jwks-key");
    });

    it("JSON 格式错误时返回 null", () => {
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      writeFileSync(configPath, "{ invalid json }", "utf-8");
      const result = readDbConfig();
      expect(result).toBeNull();
    });

    it("缺少必需字段时返回 null", () => {
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      const incomplete = { type: "postgresql", hostname: "localhost" };
      writeFileSync(configPath, JSON.stringify(incomplete), "utf-8");
      const result = readDbConfig();
      expect(result).toBeNull();
    });

    it("不支持的数据库类型返回 null", () => {
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      const invalid = { ...validConfig, type: "sqlite" };
      writeFileSync(configPath, JSON.stringify(invalid), "utf-8");
      const result = readDbConfig();
      expect(result).toBeNull();
    });
  });

  describe("isDatabaseConfigured", () => {
    it("环境变量存在时返回 true", () => {
      process.env.DATABASE_URL = "postgresql://user:pass@localhost/db";
      expect(isDatabaseConfigured()).toBe(true);
    });

    it("配置文件存在时返回 true", () => {
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      writeFileSync(configPath, JSON.stringify(validConfig), "utf-8");
      expect(isDatabaseConfigured()).toBe(true);
    });

    it("环境变量和配置文件都不存在时返回 false", () => {
      expect(isDatabaseConfigured()).toBe(false);
    });

    it("环境变量优先级高于配置文件", () => {
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      writeFileSync(configPath, JSON.stringify(validConfig), "utf-8");
      process.env.DATABASE_URL = "postgresql://env:env@localhost/envdb";
      expect(isDatabaseConfigured()).toBe(true);
    });
  });

  describe("getDatabaseUrl", () => {
    it("优先使用环境变量", () => {
      process.env.DATABASE_URL = "postgresql://env:env@localhost/envdb";
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      writeFileSync(configPath, JSON.stringify(validConfig), "utf-8");
      expect(getDatabaseUrl()).toBe("postgresql://env:env@localhost/envdb");
    });

    it("环境变量不存在时从配置文件生成", () => {
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      writeFileSync(configPath, JSON.stringify(validConfig), "utf-8");
      const url = getDatabaseUrl();
      // 密码 p@ssw0rd!# 中的 @ 和 # 会被编码为 %40 和 %23
      expect(url).toBe(
        "postgresql://testuser:p%40ssw0rd!%23@db.example.com:5432/testdb?ssl=true"
      );
    });

    it("都没有时返回 null", () => {
      expect(getDatabaseUrl()).toBeNull();
    });
  });

  describe("configToDatabaseUrl", () => {
    it("应该正确生成 PostgreSQL URL（密码包含特殊字符时自动编码）", () => {
      const url = configToDatabaseUrl(validConfig);
      // 密码 p@ssw0rd!# 中的 @ 和 # 会被编码为 %40 和 %23
      expect(url).toBe(
        "postgresql://testuser:p%40ssw0rd!%23@db.example.com:5432/testdb?ssl=true"
      );
    });

    it("应该正确生成 MySQL URL", () => {
      const url = configToDatabaseUrl(mysqlConfig);
      expect(url).toBe(
        "mysql://root:mysqlpass@mysql.example.com:3306/mysqldb"
      );
    });

    it("不使用 SSL 时不应添加 ?ssl=true", () => {
      const noSsl = { ...validConfig, ssl: false };
      const url = configToDatabaseUrl(noSsl);
      expect(url).not.toContain("ssl=true");
    });

    it("端口为 0 时应使用默认端口", () => {
      const noPort = { ...validConfig, port: 0 };
      const url = configToDatabaseUrl(noPort);
      expect(url).toContain(":5432/");
    });

    it("MySQL 默认端口应为 3306", () => {
      const noPort = { ...mysqlConfig, port: 0 };
      const url = configToDatabaseUrl(noPort);
      expect(url).toContain(":3306/");
    });
  });

  describe("loadConfigFromEnv", () => {
    it("应该从配置文件加载 DATABASE_URL 到环境变量", () => {
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      writeFileSync(configPath, JSON.stringify(validConfig), "utf-8");
      loadConfigFromEnv();
      // 密码 p@ssw0rd!# 中的 @ 和 # 会被编码为 %40 和 %23
      expect(process.env.DATABASE_URL).toBe(
        "postgresql://testuser:p%40ssw0rd!%23@db.example.com:5432/testdb?ssl=true"
      );
    });

    it("应该从配置文件加载 JWKS_KEY", () => {
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      const configWithJwks = { ...validConfig, jwksKey: "my-jwks-key" };
      writeFileSync(configPath, JSON.stringify(configWithJwks), "utf-8");
      loadConfigFromEnv();
      expect(process.env.JWKS_KEY).toBe("my-jwks-key");
    });

    it("环境变量已存在时不应覆盖 DATABASE_URL", () => {
      process.env.DATABASE_URL =
        "postgresql://existing:existing@localhost/existing";
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      writeFileSync(configPath, JSON.stringify(validConfig), "utf-8");
      loadConfigFromEnv();
      expect(process.env.DATABASE_URL).toBe(
        "postgresql://existing:existing@localhost/existing"
      );
    });

    it("环境变量已存在时不应覆盖 JWKS_KEY", () => {
      process.env.JWKS_KEY = "existing-jwks";
      const configPath = join(process.cwd(), TEST_DATA_DIR, "db-config.json");
      const configWithJwks = { ...validConfig, jwksKey: "new-jwks-key" };
      writeFileSync(configPath, JSON.stringify(configWithJwks), "utf-8");
      loadConfigFromEnv();
      expect(process.env.JWKS_KEY).toBe("existing-jwks");
    });

    it("配置文件不存在时不应设置环境变量", () => {
      loadConfigFromEnv();
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(process.env.JWKS_KEY).toBeUndefined();
    });
  });
});
