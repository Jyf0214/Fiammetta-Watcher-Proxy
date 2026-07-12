import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient() {
  const baseLog: ("query" | "error" | "warn")[] =
    process.env.NODE_ENV === "development"
      ? ["query", "error", "warn"]
      : ["error"];

  // 连接池优化：限制连接数减少内存占用，适合小内存环境
  const databaseUrl = process.env.DATABASE_URL;
  const separator = databaseUrl?.includes("?") ? "&" : "?";
  const optimizedUrl = databaseUrl
    ? `${databaseUrl}${separator}connection_limit=5&pool_timeout=10`
    : undefined;

  return new PrismaClient({
    log: baseLog,
    ...(optimizedUrl && {
      datasources: {
        db: {
          url: optimizedUrl,
        },
      },
    }),
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
