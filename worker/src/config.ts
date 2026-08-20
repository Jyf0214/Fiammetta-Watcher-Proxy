/**
 * Worker 配置读取工具
 * 使用 Prisma ORM 操作 configs 表
 *
 * 配置键约定：
 * - system:* 前缀：系统级配置（由管理后台设置）
 * - 其他键：由各模块自行定义
 */

import { createDb } from "@/lib/prisma";

/** Worker 环境变量类型 */
export interface WorkerEnv {
  DB_TYPE?: string;
  DATABASE_URL?: string;
  TIDB_URL?: string;
  MYSQL_URL?: string;
  PG_URL?: string;
  MARIADB_URL?: string;
  HYPERDRIVE?: { connectionString: string };
  /** 节点/设备名称（请求日志 nodeName 列；未设置时回退部署平台名） */
  NODE_NAME?: string;
  /** 部署平台标识（edgeone/vercel/docker/cf；NODE_NAME 未设置时的回退来源） */
  DEPLOY_PLATFORM?: string;
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
