import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

let initialized = false;

async function initAdmin() {
  if (initialized) return;
  initialized = true;

  try {
    const { initializeAdmin } = await import("@/services/init");
    await initializeAdmin();
  } catch (error) {
    console.error("[中间件] 管理员初始化失败:", error);
  }
}

export async function middleware(request: NextRequest) {
  // 仅在首次请求时初始化
  if (!initialized) {
    await initAdmin();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
