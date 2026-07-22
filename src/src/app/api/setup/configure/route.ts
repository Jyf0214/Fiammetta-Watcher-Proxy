/**
 * Setup 配置 API — 接收数据库配置并写入 db-config.json
 * 用于远程配置数据库连接
 *
 * 保存方式：数据库配置保存到 db-config.json (data/db-config.json)
 * 其他配置（ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET）不保存到文件
 *
 * 配置成功后自动执行：
 * 1. prisma db push（创建/更新数据库表）
 * 2. initializeAdmin（创建管理员账户）
 */
import { NextResponse } from "next/server";
import { saveDbConfig } from "@/lib/config";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { createPrivateKey } from "crypto";

/**
 * 校验 JWKS_KEY 是否包含完整的 RSA 私钥字段
 * 返回 null 表示有效，否则返回错误描述
 */
function validateJwksKey(raw: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "JSON 格式无效";
  }

  // 支持 JWKS 格式 { keys: [...] } 或单个 JWK 格式 { kty: "RSA", d: "..." }
  const jwk = Array.isArray(parsed.keys) ? parsed.keys[0] as Record<string, unknown> : parsed;

  if (!jwk || typeof jwk !== "object") {
    return "未找到有效的密钥对象";
  }

  if (jwk.kty !== "RSA") {
    return "密钥类型必须为 RSA";
  }

  if (typeof jwk.d !== "string") {
    return "缺少私钥参数 d";
  }

  // RSA 私钥必须包含 CRT 参数
  const requiredFields = ["n", "e", "p", "q", "dp", "dq", "qi"] as const;
  const missing = requiredFields.filter((f) => typeof jwk[f] !== "string");
  if (missing.length > 0) {
    return `缺少 RSA 私钥参数: ${missing.join(", ")}`;
  }

  // 尝试用 Node.js crypto 解析，确保密钥本身有效
  try {
    createPrivateKey({ key: jwk as never, format: "jwk" });
  } catch (e) {
    return `密钥解析失败: ${e instanceof Error ? e.message : String(e)}`;
  }

  return null;
}

interface SetupConfig {
  DATABASE_URL: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  JWT_SECRET?: string;
  JWKS_KEY?: string;
}

// 并发保护标记：防止多个请求同时配置
let isConfiguring = false;

export async function POST(request: Request) {
  try {
    // 并发保护：防止多个请求同时配置
    if (isConfiguring) {
      return NextResponse.json(
        { success: false, error: "配置正在进行中，请稍后重试" },
        { status: 429 }
      );
    }

    isConfiguring = true;

    const config: SetupConfig = await request.json();

    // 验证必需字段
    if (!config.DATABASE_URL || !config.ADMIN_USERNAME || !config.ADMIN_PASSWORD) {
      return NextResponse.json(
        { success: false, error: "缺少必需的配置字段" },
        { status: 400 }
      );
    }

    // 验证数据库 URL 格式（简单验证）
    const validDbPrefixes = ["postgresql://", "mysql://", "postgres://"];
    if (!validDbPrefixes.some((prefix) => config.DATABASE_URL.startsWith(prefix))) {
      return NextResponse.json(
        { success: false, error: "数据库 URL 格式无效，必须以 postgresql://、mysql:// 或 postgres:// 开头" },
        { status: 400 }
      );
    }

    // 验证 JWKS_KEY 完整性（如果提供了的话）
    if (config.JWKS_KEY) {
      const jwksError = validateJwksKey(config.JWKS_KEY);
      if (jwksError) {
        return NextResponse.json(
          { success: false, error: `JWKS_KEY 无效: ${jwksError}` },
          { status: 400 }
        );
      }
    }

    // 检查是否已有数据库配置（禁止重复设置）
    if (process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "数据库已配置，不允许通过 API 修改。如需更改配置，请手动编辑 data/db-config.json 文件" },
        { status: 403 }
      );
    }

    // 保存数据库配置到 db-config.json
    // 直接保存原始 DATABASE_URL，避免解析/重新生成导致参数丢失
    // 同时保存管理员凭据，确保重启后能自动加载
    try {
      const url = new URL(config.DATABASE_URL);
      const dbConfig = {
        type: url.protocol === "postgresql:" ? "postgresql" as const : "mysql" as const,
        hostname: url.hostname,
        port: url.port ? parseInt(url.port) : (url.protocol === "postgresql:" ? 5432 : 3306),
        dbName: decodeURIComponent(url.pathname.slice(1)),
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        ssl: url.searchParams.get("ssl") === "true" || url.searchParams.get("sslmode") !== null,
        sslAccept: url.searchParams.get("sslaccept") || undefined, // TiDB Cloud 特有参数
        jwksKey: config.JWKS_KEY || undefined,
        // 保存原始 URL，确保特殊参数不丢失
        rawUrl: config.DATABASE_URL,
        // 保存管理员凭据，确保重启后能自动加载
        adminUsername: config.ADMIN_USERNAME,
        adminPassword: config.ADMIN_PASSWORD,
      };
      const saved = saveDbConfig(dbConfig);
      if (!saved) {
        return NextResponse.json(
          { success: false, error: "配置文件写入失败，请检查目录权限" },
          { status: 500 }
        );
      }
    } catch (error) {
      console.error("[Setup API] DATABASE_URL 解析失败:", error);
      return NextResponse.json(
        { success: false, error: "数据库 URL 格式无效" },
        { status: 400 }
      );
    }

    // 更新进程环境变量（立即生效）
    process.env.DATABASE_URL = config.DATABASE_URL;
    process.env.ADMIN_USERNAME = config.ADMIN_USERNAME;
    process.env.ADMIN_PASSWORD = config.ADMIN_PASSWORD;
    if (config.JWT_SECRET) {
      process.env.JWT_SECRET = config.JWT_SECRET;
    }
    if (config.JWKS_KEY) {
      process.env.JWKS_KEY = config.JWKS_KEY;
    }

    // ==================== 数据库迁移 ====================
    // 执行 prisma db push 创建数据库表
    // 创建临时 schema 文件，根据数据库类型动态设置 provider
    console.log("[Setup API] 开始执行数据库迁移...");
    let tempSchemaPath = "";
    try {
      // 确定数据库类型
      const dbType = config.DATABASE_URL.startsWith("mysql") ? "mysql" : "postgresql";

      // 读取原始 schema 并修改 provider
      const originalSchema = readFileSync("prisma/schema.prisma", "utf-8");
      let tempSchema = originalSchema;

      if (dbType === "mysql" && originalSchema.includes('provider = "postgresql"')) {
        tempSchema = originalSchema.replace('provider = "postgresql"', 'provider = "mysql"');
      } else if (dbType === "postgresql" && originalSchema.includes('provider = "mysql"')) {
        tempSchema = originalSchema.replace('provider = "mysql"', 'provider = "postgresql"');
      }

      // 创建临时 schema 文件（在项目目录内，确保 Prisma 能找到 package.json）
      tempSchemaPath = `prisma/schema.setup.${Date.now()}.prisma`;
      writeFileSync(tempSchemaPath, tempSchema, "utf-8");

      // 使用临时 schema 执行 db push
      const output = execSync(`npx prisma db push --schema=${tempSchemaPath} --accept-data-loss`, {
        stdio: "pipe",
        timeout: 60000,
        encoding: "utf-8",
      });
      console.log("[Setup API] 数据库迁移完成");
      console.log("[Setup API] Prisma 输出:", output);
    } catch (error: unknown) {
      // 提取具体的错误信息
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const stderr = err.stderr || "";
      const stdout = err.stdout || "";
      const errorMsg = stderr || stdout || err.message || "未知错误";

      console.error("[Setup API] 数据库迁移失败:", errorMsg);

      // 返回更具体的错误信息
      let userMessage = "数据库迁移失败";
      if (errorMsg.includes("ECONNREFUSED")) {
        userMessage = "数据库连接被拒绝，请检查主机地址和端口是否正确";
      } else if (errorMsg.includes("Access denied")) {
        userMessage = "数据库访问被拒绝，请检查用户名和密码是否正确";
      } else if (errorMsg.includes("Unknown database")) {
        userMessage = "数据库不存在，请先在 TiDB Cloud 控制台创建数据库";
      } else if (errorMsg.includes("SSL")) {
        userMessage = "SSL 连接失败，请检查 sslaccept 参数是否正确";
      } else if (errorMsg.includes("timeout")) {
        userMessage = "数据库连接超时，请检查网络连接和防火墙设置";
      } else if (errorMsg.includes("P1001")) {
        userMessage = "无法连接到数据库服务器，请检查网络连接";
      } else if (errorMsg.includes("P1012")) {
        userMessage = "Prisma schema 配置错误";
      }

      return NextResponse.json(
        { success: false, error: `${userMessage}\n\n详细信息: ${errorMsg.slice(0, 500)}` },
        { status: 500 }
      );
    } finally {
      // 清理临时 schema 文件
      if (tempSchemaPath && existsSync(tempSchemaPath)) {
        try {
          unlinkSync(tempSchemaPath);
        } catch {
          // 忽略清理错误
        }
      }
    }

    // ==================== 管理员初始化 ====================
    console.log("[Setup API] 开始初始化管理员账户...");
    try {
      const { initializeAdmin } = await import("@/services/init");
      await initializeAdmin();
      console.log("[Setup API] 管理员账户初始化完成");
    } catch (error) {
      console.error("[Setup API] 管理员初始化失败:", error);
      // 管理员初始化失败不阻止配置完成，只记录警告
    }

    return NextResponse.json({
      success: true,
      message: "配置已成功写入 db-config.json，数据库迁移完成",
      data: {
        savedToConfigFile: true,
        databaseMigrated: true,
      },
    });
  } catch (error) {
    console.error("[Setup API] 配置写入失败:", error);
    return NextResponse.json(
      { success: false, error: "配置写入失败，请检查权限" },
      { status: 500 }
    );
  } finally {
    // 无论成功或失败，都重置并发保护标记
    isConfiguring = false;
  }
}
