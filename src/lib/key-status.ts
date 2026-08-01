// ================================================================
// Key 状态入口 — 统一从 lib/key-status 导出
//
// 根 tsconfig 的 @/* 别名指向 src/*，而共享实现位于根目录 lib/key-status.ts。
// 此文件作为桥接层，让 pages 侧与 worker 侧都能通过 @/lib/key-status 引用。
// ================================================================

export {
  keyFingerprint,
  keyStatusKey,
  readPlatformKeyStatus,
  writePlatformKeyStatus,
  KEY_STATUS_PREFIX,
  type KeyStatusValue,
  type PlatformKeyStatus,
} from "../../lib/key-status";
