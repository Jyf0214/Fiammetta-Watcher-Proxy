/**
 * BigInt 序列化辅助
 *
 * D1 (SQLite) 的 INTEGER 字段在应用层为 number 类型，
 * 但仍需处理可能的 BigInt 值，确保 JSON 序列化安全。
 * 纯函数，不修改原对象。
 */

/**
 * 将对象中的 BigInt 字段转为字符串（JSON 安全）
 */
export function serializeBigInt<T extends Record<string, unknown>>(obj: T): T {
  const result = { ...obj } as Record<string, unknown>;
  // ApiKey 字段
  if (typeof result.usedTokens === "bigint") result.usedTokens = String(result.usedTokens);
  if (typeof result.tokenLimit === "bigint") result.tokenLimit = String(result.tokenLimit);
  // 嵌套 Plan 字段（浅拷贝防止修改原对象）
  if (result.plan && typeof result.plan === "object" && !Array.isArray(result.plan)) {
    result.plan = { ...(result.plan as Record<string, unknown>) };
    const plan = result.plan as Record<string, unknown>;
    if (typeof plan.tokenQuota === "bigint") plan.tokenQuota = String(plan.tokenQuota);
  }
  return result as T;
}

/**
 * 批量序列化 BigInt 字段
 */
export function serializeBigIntArray<T extends Record<string, unknown>>(arr: T[]): ReturnType<typeof serializeBigInt<T>>[] {
  return arr.map(serializeBigInt);
}
