#!/usr/bin/env node
/**
 * 管理员初始化脚本
 * 1. 优先使用 ADMIN_USERNAME / ADMIN_PASSWORD 环境变量
 * 2. 若未设置且数据库无管理员，自动创建默认账户 admin / admin123
 *
 * 密码哈希算法与 src/lib/auth-helpers.ts 保持一致：PBKDF2 10000 次 sha256
 */
const { PrismaClient } = require("@prisma/client");
const crypto = require("crypto");

const prisma = new PrismaClient();

const SALT_LENGTH = 16;
const HASH_ITERATIONS = 10000;
const KEY_LENGTH = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LENGTH).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, HASH_ITERATIONS, KEY_LENGTH, "sha256");
  return `${salt}:${hash.toString("hex")}`;
}

async function createAdmin(username, password) {
  const passwordHash = hashPassword(password);
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
}

async function main() {
  try {
    const adminCount = await prisma.admin.count();

    if (adminCount > 0) {
      console.log(`[init-admin] 已存在 ${adminCount} 个管理员，跳过`);
      return;
    }

    const username = process.env.ADMIN_USERNAME;
    const password = process.env.ADMIN_PASSWORD;

    if (username && password) {
      await createAdmin(username, password);
    } else {
      console.log("[init-admin] 未设置 ADMIN_USERNAME / ADMIN_PASSWORD，使用默认账户");
      await createAdmin("admin", "admin123");
      console.log("[init-admin] 默认管理员: admin / admin123（请尽快修改密码）");
    }
  } catch (error) {
    console.error("[init-admin] 初始化失败:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
