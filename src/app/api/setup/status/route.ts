/**
 * Setup 状态检查 API — 检查数据库环境变量是否已配置
 * 用于前端判断是否需要引导用户到 /setup 页面
 */
import { NextResponse } from "next/server";

export async function GET() {
  const hasDatabaseUrl = !!process.env.DATABASE_URL;
  const hasAdminUsername = !!process.env.ADMIN_USERNAME;
  const hasAdminPassword = !!process.env.ADMIN_PASSWORD;
  const hasJwtSecret = !!process.env.JWT_SECRET || !!process.env.JWKS_KEY;

  const isConfigured = hasDatabaseUrl && hasAdminUsername && hasAdminPassword && hasJwtSecret;

  return NextResponse.json({
    success: true,
    data: {
      configured: isConfigured,
      missing: {
        DATABASE_URL: !hasDatabaseUrl,
        ADMIN_USERNAME: !hasAdminUsername,
        ADMIN_PASSWORD: !hasAdminPassword,
        JWT_SECRET: !hasJwtSecret && !hasAdminPassword,
      },
    },
  });
}
