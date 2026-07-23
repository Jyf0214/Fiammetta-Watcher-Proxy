// ================================================================
// 数据库入口 — 统一从 prisma.ts 导出
//
// 所有文件应从此处或 @/lib/prisma 导入 createDb / disconnectDb / Database
// 此文件保留是为了向后兼容现有 import 路径
// ================================================================

export { createDb, disconnectDb, type Database } from "./prisma";
