import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";

/**
 * 管理员初始化服务
 * 首次启动时通过环境变量自动创建管理员账户
 */
export async function initializeAdmin(): Promise<void> {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    console.warn(
      "[初始化] 未设置 ADMIN_USERNAME 或 ADMIN_PASSWORD 环境变量，跳过管理员初始化"
    );
    return;
  }

  // 检查是否已存在管理员
  const existingAdmin = await prisma.admin.findUnique({
    where: { username },
  });

  if (existingAdmin) {
    console.log(`[初始化] 管理员账户 "${username}" 已存在，跳过创建`);
    return;
  }

  // 创建管理员账户
  const passwordHash = await hashPassword(password);
  await prisma.admin.create({
    data: {
      username,
      passwordHash,
    },
  });

  console.log(`[初始化] 管理员账户 "${username}" 创建成功`);

  // 记录系统事件
  await prisma.systemEvent.create({
    data: {
      level: "info",
      message: "系统初始化完成",
      detail: JSON.stringify({
        adminCreated: true,
        username,
        timestamp: new Date().toISOString(),
      }),
    },
  });
}

/**
 * 数据库迁移（通过 prisma db push 实现）
 * 仅在 pre-start 脚本中调用，不在运行时执行
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
