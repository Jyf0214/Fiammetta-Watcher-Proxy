// ================================================================
// Prisma 入口 — 统一从 lib/prisma 导出
//
// 所有文件应从此处或 @/lib/prisma 导入 createDb / disconnectDb / Database
// 此文件作为 @/* 路径别名的桥接层
// ================================================================

export { createDb, disconnectDb, type Database } from "../../lib/prisma";
