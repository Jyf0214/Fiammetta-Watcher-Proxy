// ================================================================
// 数据库入口 — 统一从 database.ts 导出
//
// 所有文件应从此处或 @/lib/database 导入 createDb 和 schema
// 此文件保留是为了向后兼容现有 import 路径（Pages 侧 @/lib/db）
// ================================================================

export { createDb, type Database } from "../../lib/database";
