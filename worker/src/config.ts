/**
 * Worker 配置读取工具
 * 使用 Prisma ORM 操作 configs 表
 *
 * 配置键约定：
 * - system:* 前缀：系统级配置（由管理后台设置）
 * - frontend_config：前端配置（JSON 格式）
 * - 其他键：由各模块自行定义
 */

import { createDb } from "@/lib/prisma";

/** Worker 环境变量类型 */
export interface WorkerEnv {
  DB_TYPE?: string;
  DATABASE_URL?: string;
  TIDB_URL?: string;
  PG_URL?: string;
  MARIADB_URL?: string;
  HYPERDRIVE?: { connectionString: string };
}

/**
 * 获取配置值
 * @param db D1 数据库绑定
 * @param key 配置键
 * @param env Worker 环境变量（包含 DB_TYPE）
 * @returns 配置值字符串，未找到返回 null
 */
export async function getConfig(
  db: D1Database,
  key: string,
  env?: WorkerEnv
): Promise<string | null> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  try {
    const row = await prisma.configs.findFirst({
      where: { key },
      select: { value: true },
    });
    return row?.value ?? null;
  } catch (err) {
    console.error(`[config] 获取配置 ${key} 失败:`, err instanceof Error ? err.message : String(err));
    throw err;
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
  key: string,
  env?: WorkerEnv
): Promise<T | null> {
  const value = await getConfig(db, key, env);
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
  defaultValue: string,
  env?: WorkerEnv
): Promise<string> {
  const value = await getConfig(db, key, env);
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
  value: string,
  env?: WorkerEnv
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  try {
    await prisma.configs.upsert({
      where: { key },
      create: { id: crypto.randomUUID(), key, value, updatedAt: now },
      update: { value, updatedAt: now },
    });
  } catch (err) {
    console.error(`[config] 设置配置 ${key} 失败:`, err instanceof Error ? err.message : String(err));
    throw err;
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
  data: Record<string, unknown>,
  env?: WorkerEnv
): Promise<void> {
  await setConfig(db, key, JSON.stringify(data), env);
}

/**
 * 删除配置
 * @param db D1 数据库绑定
 * @param key 配置键
 * @returns 是否成功删除（true 表示确实删除了记录）
 */
export async function deleteConfig(
  db: D1Database,
  key: string,
  env?: WorkerEnv
): Promise<boolean> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
  try {
    const result = await prisma.configs.deleteMany({ where: { key } });
    return result.count > 0;
  } catch (err) {
    console.error(`[config] 删除配置 ${key} 失败:`, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * 获取所有 system:* 前缀的系统配置
 * @param db D1 数据库绑定
 * @returns 配置键值对
 */
export async function getAllSystemConfigs(
  db: D1Database,
  env?: WorkerEnv
): Promise<Record<string, string>> {
  const prisma = await createDb({ DB: db, DB_TYPE: env?.DB_TYPE });
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
  } catch (err) {
    console.error("[config] 获取系统配置失败:", err instanceof Error ? err.message : String(err));
    throw err;
  }
}
