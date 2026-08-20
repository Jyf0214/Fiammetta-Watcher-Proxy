/**
 * Worker 环境变量同步（全量版与 lite 版 Worker 共用）
 *
 * lib/prisma.ts 的数据库类型解析同时读取 env 对象与 process.env，
 * 而各业务模块只把 { DB, DB_TYPE } 传给 createDb，DATABASE_URL 等
 * Secret/Var 不会进入解析链，导致 Worker 永远推断为 d1（状态写入错误的库）。
 * 在入口统一同步，保证所有 createDb 调用都能解析到正确的数据库类型。
 */

export function syncWorkerEnv(env: { DB_TYPE?: string; DATABASE_URL?: string; TIDB_URL?: string; MYSQL_URL?: string; PG_URL?: string; MARIADB_URL?: string; HYPERDRIVE?: { connectionString: string }; NODE_NAME?: string; DEPLOY_PLATFORM?: string }): void {
  if (env.DB_TYPE) process.env.DB_TYPE = env.DB_TYPE;
  if (env.DATABASE_URL) process.env.DATABASE_URL = env.DATABASE_URL;
  if (env.TIDB_URL) process.env.TIDB_URL = env.TIDB_URL;
  if (env.MYSQL_URL) process.env.MYSQL_URL = env.MYSQL_URL;
  if (env.PG_URL) process.env.PG_URL = env.PG_URL;
  if (env.MARIADB_URL) process.env.MARIADB_URL = env.MARIADB_URL;
  if (env.HYPERDRIVE) process.env.HYPERDRIVE = JSON.stringify(env.HYPERDRIVE);
  if (env.NODE_NAME) process.env.NODE_NAME = env.NODE_NAME;
  if (env.DEPLOY_PLATFORM) process.env.DEPLOY_PLATFORM = env.DEPLOY_PLATFORM;
}
