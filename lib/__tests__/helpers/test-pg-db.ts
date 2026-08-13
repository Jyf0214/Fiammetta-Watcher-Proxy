/**
 * 测试专用虚拟 PostgreSQL 数据库（PGlite，WASM 内存实现）
 *
 * 每个测试文件（vitest worker 进程）在内存中启动一个真实 PostgreSQL 内核
 * （@electric-sql/pglite，PostgreSQL 编译为 WASM，仅存在于测试进程，测试结束即销毁）：
 *   1. PGlite.create() 启动内存 PostgreSQL
 *   2. PGLiteSocketServer 暴露 Postgres wire 协议（本机随机端口）
 *   3. 表结构由 `prisma migrate diff --from-empty` 从 prisma/schema.pg.prisma
 *      派生（非手写 DDL，与生产 schema 完全一致）
 *   4. 通过 lib/prisma 的真实 createDb 工厂（pg 方言）连接
 *
 * 不连接任何外部数据库服务器，不污染开发/生产数据。
 */
import { execSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDb, disconnectDb } from "@/lib/prisma";
import type { Database } from "@/lib/prisma";

export interface TestDb {
  /** 通过 lib/prisma createDb 工厂获得的真实 Prisma Client（pg 方言） */
  db: Database;
  /** 内存 PostgreSQL 的完整连接串（可写回 process.env.PG_URL 供无参 createDb() 复用） */
  url: string;
  /** 停止 wire server、断开 Prisma 连接、释放 WASM 内存 */
  cleanup: () => Promise<void>;
}

/**
 * 创建虚拟 PostgreSQL 测试数据库（PGlite 内存实例 + migrate diff 派生表结构）
 */
export async function createTestDb(): Promise<TestDb> {
  // createDb 按方言键控全局缓存：清掉上一个测试文件的实例，防止本文件内
  // 二次建库时静默命中旧库（连接错库 + 旧 PGlite 泄漏）
  await disconnectDb();

  const pglite = await PGlite.create();
  const server = new PGLiteSocketServer({
    db: pglite,
    port: 0, // 由操作系统分配随机端口，vitest 并行 worker 互不冲突
    host: "127.0.0.1",
    maxConnections: 10,
  });
  await server.start();

  const [host, port] = server.getServerConn().split(":");
  const url = `postgresql://postgres:postgres@${host}:${port}/postgres`;

  // 建表：schema.pg.prisma 派生 DDL（--from-empty），与生产表结构一致，非手写
  const ddl = execSync(
    "npx prisma migrate diff --from-empty --to-schema prisma/schema.pg.prisma --script",
    { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 }
  );
  const { Pool } = await import("pg");
  const setup = new Pool({ connectionString: url });
  try {
    await setup.query(ddl);
  } finally {
    await setup.end();
  }

  const db = await createDb({ DB_TYPE: "pg", PG_URL: url });

  return {
    db,
    url,
    cleanup: async () => {
      // 先断开 Prisma（PostgreSQL 客户端主动发送 Terminate 消息），再停 wire server：
      // 若服务端先断开空闲连接，PostgreSQL 连接池会记录一条"意外终止"错误日志
      await db.$disconnect();
      await server.stop();
      await pglite.close();
    },
  };
}
