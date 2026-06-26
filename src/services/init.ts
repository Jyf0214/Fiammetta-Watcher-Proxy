import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";

const RESET_FLAG_KEY = "admin_reset_password";

/**
 * 环境变量校验 — 缺少必需变量时直接崩溃，阻止启动
 */
function validateRequiredEnvVars(): void {
  const required = ["JWT_SECRET", "ADMIN_USERNAME", "ADMIN_PASSWORD", "DATABASE_URL"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    const msg = `[致命错误] 缺少必需环境变量: ${missing.join(", ")}。系统无法启动，请配置后重试`;
    console.error(msg);
    throw new Error(msg);
  }
}

/**
 * 管理员初始化服务
 *
 * 启动时执行以下逻辑：
 * 0. 校验必需环境变量（JWT_SECRET / ADMIN_USERNAME / ADMIN_PASSWORD / DATABASE_URL）
 * 1. 若数据库无管理员 → 从环境变量创建
 * 2. 若数据库已有管理员且存在重置标志 → 用环境变量密码强制更新
 * 3. 重置时检测 ADMIN_USERNAME 与现有管理员是否匹配，不匹配则报错退出
 */
export async function initializeAdmin(): Promise<void> {
  // 校验必需环境变量
  validateRequiredEnvVars();

  const username = process.env.ADMIN_USERNAME!;
  const password = process.env.ADMIN_PASSWORD!;

  // ---- 场景 1：首次创建管理员 ----
  const adminCount = await prisma.admin.count();

  if (adminCount === 0) {
    if (!username || !password) {
      console.warn(
        "[初始化] 未设置 ADMIN_USERNAME 或 ADMIN_PASSWORD 环境变量，跳过管理员初始化"
      );
      return;
    }

    const passwordHash = await hashPassword(password);
    await prisma.admin.create({
      data: { username, passwordHash },
    });

    console.log(`[初始化] 管理员账户 "${username}" 创建成功`);

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
    return;
  }

  // ---- 场景 2：管理员已存在，检查重置标志 ----
  const resetFlag = await prisma.config.findUnique({
    where: { key: RESET_FLAG_KEY },
  });

  if (!resetFlag || resetFlag.value !== "pending") {
    // 无重置标志，正常跳过
    return;
  }

  // 有重置标志，执行密码重置
  if (!username || !password) {
    console.error(
      "[初始化] 检测到密码重置标志，但未设置 ADMIN_USERNAME 或 ADMIN_PASSWORD 环境变量，跳过重置"
    );
    return;
  }

  const admin = await prisma.admin.findFirst();
  if (!admin) {
    console.error("[初始化] 检测到密码重置标志，但数据库中无管理员账户");
    return;
  }

  // 检测管理员名称是否匹配
  if (admin.username !== username) {
    const msg = `[初始化] 错误：环境变量 ADMIN_USERNAME="${username}" 与数据库管理员 "${admin.username}" 不匹配。请修改 ADMIN_USERNAME 环境变量为 "${admin.username}" 后重启`;
    console.error(msg);
    await prisma.systemEvent.create({
      data: {
        level: "error",
        message: "密码重置失败：管理员名称不匹配",
        detail: JSON.stringify({
          envUsername: username,
          dbUsername: admin.username,
          timestamp: new Date().toISOString(),
        }),
      },
    });
    return;
  }

  // 执行密码更新
  const newPasswordHash = await hashPassword(password);
  await prisma.admin.update({
    where: { id: admin.id },
    data: { passwordHash: newPasswordHash },
  });

  // 清除重置标志
  await prisma.config.delete({ where: { key: RESET_FLAG_KEY } });

  console.log(`[初始化] 管理员 "${username}" 密码已重置`);

  await prisma.systemEvent.create({
    data: {
      level: "info",
      message: "管理员密码已重置",
      detail: JSON.stringify({
        username,
        timestamp: new Date().toISOString(),
      }),
    },
  });
}

/**
 * 数据库连接检查
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
