#!/usr/bin/env node
/**
 * 管理员初始化脚本
 * 通过环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 创建初始管理员账户
 */
const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto");

const prisma = new PrismaClient();

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    console.log("[init-admin] 未设置 ADMIN_USERNAME 或 ADMIN_PASSWORD，跳过");
    return;
  }

  try {
    const existing = await prisma.admin.findUnique({ where: { username } });
    if (existing) {
      console.log(`[init-admin] 管理员 "${username}" 已存在，跳过`);
      return;
    }

    const passwordHash = await hashPassword(password);
    await prisma.admin.create({
      data: { username, passwordHash },
    });

    console.log(`[init-admin] 管理员 "${username}" 创建成功`);

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
  } catch (error) {
    console.error("[init-admin] 初始化失败:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
