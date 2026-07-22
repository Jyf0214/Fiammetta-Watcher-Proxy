/**
 * Setup 状态检查 API — 检查数据库环境变量是否已配置
 * 用于前端判断是否需要引导用户到 /setup 页面
 *
 * 支持两种配置方式：
 * 1. 环境变量 (DATABASE_URL)
 * 2. 配置文件 (data/db-config.json)
 */
import { NextResponse } from "next/server";
import { isDatabaseConfigured } from "@/lib/config";

export async function GET() {
  const hasDatabaseUrl = isDatabaseConfigured();
  const hasAdminUsername = !!process.env.ADMIN_USERNAME;
  const hasAdminPassword = !!process.env.ADMIN_PASSWORD;
  const hasJwtSecret = !!process.env.JWT_SECRET || !!process.env.JWKS_KEY;

  const isConfigured = hasDatabaseUrl && hasAdminUsername && hasAdminPassword && hasJwtSecret;

  // 如果已配置，只返回统一的"已配置"响应，不暴露具体缺少哪些字段
  if (isConfigured) {
    return NextResponse.json({
      success: true,
      data: {
        configured: true,
      },
    });
  }

  // 未配置时，返回缺少的字段信息（用于 setup 页面引导）
  return NextResponse.json({
    success: true,
    data: {
      configured: false,
      missing: {
        DATABASE_URL: !hasDatabaseUrl,
        ADMIN_USERNAME: !hasAdminUsername,
        ADMIN_PASSWORD: !hasAdminPassword,
        JWT_SECRET: !hasJwtSecret,
      },
    },
  });
}
