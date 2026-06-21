#!/usr/bin/env node
/**
 * 管理员初始化脚本
 * 仅通过 ADMIN_USERNAME / ADMIN_PASSWORD 环境变量创建管理员账户
 * 密码哈希算法与 src/lib/auth-helpers.ts 一致：PBKDF2 10000 次 sha256
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

    const passwordHash = hashPassword(password);
    await prisma.admin.create({
      data: { username, passwordHash },
    });
    console.log(`[init-admin] 管理员 "${username}" 创建成功（密码已哈希存储）`);
  } catch (error) {
    console.error("[init-admin] 初始化失败:", error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
