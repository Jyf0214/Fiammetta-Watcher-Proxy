/**
 * Setup 配置 API — 接收环境变量并写入 .env 文件
 * 用于远程配置数据库连接和其他必需环境变量
 */
import { NextResponse } from "next/server";
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

interface SetupConfig {
  DATABASE_URL: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  JWT_SECRET?: string;
  JWKS_KEY?: string;
}

export async function POST(request: Request) {
  try {
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
    const envPath = join(process.cwd(), ".env");
    if (existsSync(envPath)) {
      const existingContent = await readFile(envPath, "utf-8");
      // 检查 .env 文件中是否已配置 DATABASE_URL
      const hasDatabaseUrlInEnv = existingContent.includes("DATABASE_URL=") &&
        !existingContent.includes('DATABASE_URL=""');
      if (hasDatabaseUrlInEnv) {
        return NextResponse.json(
          { success: false, error: "数据库已配置，不允许通过 API 修改。如需更改配置，请手动编辑 .env 文件" },
          { status: 403 }
        );
      }
    }

    // 检查环境变量是否已配置
    if (process.env.DATABASE_URL) {
      return NextResponse.json(
        { success: false, error: "数据库已配置，不允许通过 API 修改。如需更改配置，请手动编辑 .env 文件" },
        { status: 403 }
      );
    }

    // 生成 JWT_SECRET（如果未提供）
    const jwtSecret = config.JWT_SECRET || generateRandomSecret();

    // 读取现有的 .env 文件
    let existingContent = "";
    if (existsSync(envPath)) {
      existingContent = await readFile(envPath, "utf-8");
    }

    // 构建新的环境变量内容
    const envLines = [
      "# 数据库配置（由 Setup 页面写入）",
      `DATABASE_URL="${config.DATABASE_URL}"`,
      "",
      "# 管理员初始化（首次启动时自动创建）",
      `ADMIN_USERNAME="${config.ADMIN_USERNAME}"`,
      `ADMIN_PASSWORD="${config.ADMIN_PASSWORD}"`,
      "",
      "# JWT 密钥（用于管理员登录 Token 签名）",
      `JWT_SECRET="${jwtSecret}"`,
      "",
    ];

    // 保留用户自定义的配置（非必需变量）
    const essentialKeys = [
      "DATABASE_URL",
      "ADMIN_USERNAME",
      "ADMIN_PASSWORD",
      "JWT_SECRET",
      "JWKS_KEY",
    ];

    const customLines: string[] = [];
    const lines = existingContent.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) {
        // 跳过空行和注释（除了自定义部分的注释）
        continue;
      }

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.substring(0, eqIndex).trim();
        if (!essentialKeys.includes(key)) {
          customLines.push(line);
        }
      }
    }

    // 合并所有内容
    const finalContent = [
      ...envLines,
      "# 用户自定义配置（保留原有配置）",
      ...customLines,
      "",
    ].join("\n");

    // 写入 .env 文件
    await writeFile(envPath, finalContent, "utf-8");

    // 同时更新进程环境变量（立即生效）
    process.env.DATABASE_URL = config.DATABASE_URL;
    process.env.ADMIN_USERNAME = config.ADMIN_USERNAME;
    process.env.ADMIN_PASSWORD = config.ADMIN_PASSWORD;
    if (jwtSecret) {
      process.env.JWT_SECRET = jwtSecret;
    }
    if (config.JWKS_KEY) {
      process.env.JWKS_KEY = config.JWKS_KEY;
    }

    return NextResponse.json({
      success: true,
      message: "配置已成功写入 .env 文件",
      data: {
        databaseUrl: config.DATABASE_URL,
        adminUsername: config.ADMIN_USERNAME,
        jwtSecretGenerated: !config.JWT_SECRET,
      },
    });
  } catch (error) {
    console.error("[Setup API] 配置写入失败:", error);
    return NextResponse.json(
      { success: false, error: "配置写入失败，请检查权限" },
      { status: 500 }
    );
  }
}

/**
 * 生成随机 JWT 密钥
 */
function generateRandomSecret(): string {
  const array = new Uint8Array(32);
  // 使用 crypto.getRandomValues 代替 Math.random
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(array);
  } else {
    // 降级方案：使用时间戳和随机数组合（仅开发环境）
    for (let i = 0; i < array.length; i++) {
      array[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
