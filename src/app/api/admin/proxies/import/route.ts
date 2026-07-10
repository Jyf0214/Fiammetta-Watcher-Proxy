import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminFromRequest } from "@/lib/auth";
import { forceRefreshProxyCache } from "@/lib/proxy-router";

/**
 * POST /api/admin/proxies/import — 批量导入代理
 *
 * 请求体:
 *   - text: string  — 每行一条，格式 IP:端口:账号:密码
 *   - poolId?: string — 归属代理池 ID（可选）
 *
 * 去重规则：address 相同则覆盖（更新 enabled=true、status=healthy）。
 */
export async function POST(request: NextRequest) {
  const admin = await getAdminFromRequest();
  if (!admin) {
    return NextResponse.json({ success: false, error: "未授权" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { text, poolId } = body;

    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: "导入内容不能为空" },
        { status: 400 }
      );
    }

    // 校验代理池（可选）
    if (poolId && typeof poolId === "string") {
      const pool = await prisma.proxyPool.findUnique({ where: { id: poolId } });
      if (!pool) {
        return NextResponse.json(
          { success: false, error: "关联代理池不存在" },
          { status: 400 }
        );
      }
    }

    // 解析每行：IP:端口:账号:密码 → http://账号:密码@IP:端口
    const lines = text
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0 && !line.startsWith("#"));

    const parsed: { address: string; ip: string; port: string }[] = [];
    const parseErrors: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.split(":");
      if (parts.length !== 4) {
        parseErrors.push(`第 ${i + 1} 行格式错误（期望 IP:端口:账号:密码）: ${line}`);
        continue;
      }

      const [ip, port, user, pass] = parts;

      // 基础校验
      if (!ip || !port || !user || !pass) {
        parseErrors.push(`第 ${i + 1} 行包含空字段: ${line}`);
        continue;
      }

      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
        parseErrors.push(`第 ${i + 1} 行 IP 格式无效: ${ip}`);
        continue;
      }

      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        parseErrors.push(`第 ${i + 1} 行端口无效: ${port}`);
        continue;
      }

      const address = `http://${user}:${pass}@${ip}:${port}`;
      parsed.push({ address, ip, port });
    }

    if (parsed.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "没有可导入的代理",
          details: parseErrors,
        },
        { status: 400 }
      );
    }

    // 查询已有代理（按 address 去重，全局范围）
    const existingProxies = await prisma.proxy.findMany({
      select: { id: true, address: true },
    });
    const existingMap = new Map(existingProxies.map((p) => [p.address, p.id]));

    let created = 0;
    let updated = 0;

    // 使用事务批量处理
    await prisma.$transaction(async (tx) => {
      for (const item of parsed) {
        const existingId = existingMap.get(item.address);
        if (existingId) {
          // 覆盖：重置状态为可用
          await tx.proxy.update({
            where: { id: existingId },
            data: { enabled: true, status: "healthy", failCount: 0 },
          });
          updated++;
        } else {
          await tx.proxy.create({
            data: {
              address: item.address,
              poolId: poolId && typeof poolId === "string" ? poolId : null,
            },
          });
          created++;
        }
      }
    });

    await forceRefreshProxyCache();

    await prisma.auditLog.create({
      data: {
        adminId: admin.adminId,
        action: "import_proxies",
        detail: JSON.stringify({ poolId: poolId || null, created, updated, parseErrors: parseErrors.length }),
        ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null,
      },
    });

    return NextResponse.json({
      success: true,
      message: `导入完成：新增 ${created} 个，覆盖 ${updated} 个`,
      data: { created, updated, total: parsed.length, parseErrors },
    });
  } catch (err) {
    console.error("[POST /api/admin/proxies/import] 批量导入失败:", err);
    return NextResponse.json(
      { success: false, error: "批量导入失败" },
      { status: 500 }
    );
  }
}
