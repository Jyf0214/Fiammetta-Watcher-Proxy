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
import { readFileSync, writeFileSync } from "fs";

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

    // 检查是否已有数据库配置（禁止重复设置）
    if (process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "数据库已配置，不允许通过 API 修改。如需更改配置，请手动编辑 data/db-config.json 文件" },
        { status: 403 }
      );
    }

    // 从 DATABASE_URL 解析配置并保存到 db-config.json
    try {
      const url = new URL(config.DATABASE_URL);
      const dbConfig = {
        type: url.protocol === "postgresql:" ? "postgresql" as const : "mysql" as const,
        hostname: url.hostname,
        port: url.port ? parseInt(url.port) : (url.protocol === "postgresql:" ? 5432 : 3306),
        dbName: url.pathname.slice(1), // 去掉开头的 /
        username: url.username,
        password: url.password,
        ssl: url.searchParams.get("ssl") === "true",
        jwksKey: config.JWKS_KEY || undefined, // 保存 JWKS_KEY 到配置文件
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
    console.log("[Setup API] 开始执行数据库迁移...");
    try {
      // 根据数据库类型动态切换 Prisma schema provider
      const dbType = config.DATABASE_URL.startsWith("mysql") ? "mysql" : "postgresql";
      const schemaPath = "prisma/schema.prisma";
      let schemaContent = readFileSync(schemaPath, "utf-8");

      if (dbType === "postgresql" && schemaContent.includes('provider = "mysql"')) {
        schemaContent = schemaContent.replace('provider = "mysql"', 'provider = "postgresql"');
        writeFileSync(schemaPath, schemaContent, "utf-8");
      } else if (dbType === "mysql" && schemaContent.includes('provider = "postgresql"')) {
        schemaContent = schemaContent.replace('provider = "postgresql"', 'provider = "mysql"');
        writeFileSync(schemaPath, schemaContent, "utf-8");
      }

      // 执行 prisma db push
      execSync("npx prisma db push --accept-data-loss", {
        stdio: "pipe",
        timeout: 60000, // 60秒超时
      });
      console.log("[Setup API] 数据库迁移完成");
    } catch (error) {
      console.error("[Setup API] 数据库迁移失败:", error);
      return NextResponse.json(
        { success: false, error: "数据库迁移失败，请检查数据库连接是否正确" },
        { status: 500 }
      );
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
        adminUsername: config.ADMIN_USERNAME,
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
