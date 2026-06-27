/**
 * 序列化包含 BigInt 字段的对象为 JSON 安全格式
 * Prisma 的 BigInt 类型无法被 JSON.stringify 序列化
 */
export function serializeBigInt<T extends Record<string, unknown>>(obj: T): T {
  const result = obj as Record<string, unknown>;
  // ApiKey 字段
  if (typeof result.usedTokens === "bigint") result.usedTokens = String(result.usedTokens);
  if (typeof result.tokenLimit === "bigint") result.tokenLimit = String(result.tokenLimit);
  // 嵌套 Plan 字段
  if (result.plan && typeof result.plan === "object" && !Array.isArray(result.plan)) {
    const plan = result.plan as Record<string, unknown>;
    if (typeof plan.tokenQuota === "bigint") plan.tokenQuota = String(plan.tokenQuota);
  }
  return obj;
}

/** 批量序列化 */
export function serializeBigIntArray<T extends Record<string, unknown>>(arr: T[]): ReturnType<typeof serializeBigInt<T>>[] {
  return arr.map(serializeBigInt);
}
