/**
 * Worker 配置读取工具
 * 使用 Prisma ORM 操作 configs 表
 *
 * 配置键约定：
 * - system:* 前缀：系统级配置（由管理后台设置）
 * - frontend_config：前端配置（JSON 格式）
 * - 其他键：由各模块自行定义
 */

import { createPrismaClient } from "./prisma-db";

/**
 * 获取配置值
 * @param db D1 数据库绑定
 * @param key 配置键
 * @returns 配置值字符串，未找到返回 null
 */
export async function getConfig(
  db: D1Database,
  key: string
): Promise<string | null> {
  const prisma = await createPrismaClient(db);
  try {
    const row = await prisma.configs.findFirst({
      where: { key },
      select: { value: true },
    });
    return row?.value ?? null;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 获取配置值并解析为 JSON 对象
 * @param db D1 数据库绑定
 * @param key 配置键
 * @returns 解析后的对象，未找到或解析失败返回 null
 */
export async function getConfigJson<T = Record<string, unknown>>(
  db: D1Database,
  key: string
): Promise<T | null> {
  const value = await getConfig(db, key);
  if (value === null) return null;

  try {
    const parsed = JSON.parse(value);
    return parsed as T;
  } catch {
    return null;
  }
}

/**
 * 获取配置值，不存在时返回默认值
 * @param db D1 数据库绑定
 * @param key 配置键
 * @param defaultValue 默认值
 * @returns 配置值或默认值
 */
export async function getConfigOrDefault(
  db: D1Database,
  key: string,
  defaultValue: string
): Promise<string> {
  const value = await getConfig(db, key);
  return value ?? defaultValue;
}

/**
 * 设置配置值（upsert：存在则更新，不存在则插入）
 * @param db D1 数据库绑定
 * @param key 配置键
 * @param value 配置值
 */
export async function setConfig(
  db: D1Database,
  key: string,
  value: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const prisma = await createPrismaClient(db);
  try {
    await prisma.configs.upsert({
      where: { key },
      create: { id: crypto.randomUUID(), key, value, updatedAt: now },
      update: { value, updatedAt: now },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 设置 JSON 配置值
 * @param db D1 数据库绑定
 * @param key 配置键
 * @param data 配置对象（自动序列化为 JSON）
 */
export async function setConfigJson(
  db: D1Database,
  key: string,
  data: Record<string, unknown>
): Promise<void> {
  await setConfig(db, key, JSON.stringify(data));
}

/**
 * 删除配置
 * @param db D1 数据库绑定
 * @param key 配置键
 * @returns 是否成功删除（true 表示确实删除了记录）
 */
export async function deleteConfig(
  db: D1Database,
  key: string
): Promise<boolean> {
  const prisma = await createPrismaClient(db);
  try {
    const result = await prisma.configs.deleteMany({ where: { key } });
    return result.count > 0;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 获取所有 system:* 前缀的系统配置
 * @param db D1 数据库绑定
 * @returns 配置键值对
 */
export async function getAllSystemConfigs(
  db: D1Database
): Promise<Record<string, string>> {
  const prisma = await createPrismaClient(db);
  try {
    const rows = await prisma.configs.findMany({
      where: { key: { startsWith: "system:" } },
      select: { key: true, value: true },
    });

    const data: Record<string, string> = {};
    for (const row of rows) {
      data[row.key] = row.value;
    }
    return data;
  } finally {
    await prisma.$disconnect();
  }
}
