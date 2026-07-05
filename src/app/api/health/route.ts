import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    await prisma.admin.count();
    return NextResponse.json({ status: "ok", database: "connected" });
  } catch {
    // 数据库连接失败时返回降级状态，不记录详细错误避免信息泄露
    return NextResponse.json({ status: "degraded", database: "disconnected" }, { status: 503 });
  }
}
