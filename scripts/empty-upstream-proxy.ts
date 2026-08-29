// Cloudflare 部署专用（next.config.ts webpack.resolveAlias）
// CF workerd 不支持出站代理（SOCKS/HTTP proxy 出网），整个 @/lib/upstream-proxy
// 在 CF 部署下无意义，alias 到本 stub 让 Pages Function bundle 不打包原模块。
// 非 Cloudflare 平台（EdgeOne/Vercel/纯 Node）构建不使用此文件。
//
// 所有函数返回"无代理"语义；常量保留原值（管理后台 UI 仍可读/写配置，但
// 实际运行无代理可用——CF workerd 环境特性决定）。

// 常量
export const UPSTREAM_PROXY_CONFIG_KEY = "system:upstream_proxy";
export const UPSTREAM_PROXY_POOL_KEY = "system:upstream_proxy_pool";
export const UPSTREAM_PROXY_HEALTH_KEY = "system:upstream_proxy_health";
export const UPSTREAM_PROXY_PULL_AT_KEY = "system:upstream_proxy_pull_at";
export const UPSTREAM_PROXY_CHECK_LOCK_KEY = "system:upstream_proxy_check_lock";
export const DEFAULT_PROXY_HEALTH_CHECK_URL = "https://cp.cloudflare.com/generate_204";
export const DEFAULT_PROXY_HEALTH_INTERVAL_MIN = 5;
export const PROXY_HEALTH_INTERVAL_MIN_RANGE = { min: 1, max: 1440 } as const;
export const DEFAULT_PROXY_PULL_INTERVAL_MIN = 60;
export const PROXY_PULL_INTERVAL_MIN_RANGE = { min: 1, max: 20160 } as const;
export const PROXY_FAIL_THRESHOLD = 3;

// 状态查询：CF 不可用 → 永远"全部禁用" / "true"
export type UpstreamProxyDisableMode = "all" | "health";
export function getProxyDisableMode(): UpstreamProxyDisableMode | null {
  return "all";
}
export function isUpstreamProxyDisabled(): boolean {
  return true;
}
export function isScheduledProxyHealthDisabled(): boolean {
  return true;
}

// 健康检查：永远"无进行中"
export function getHealthCheckProgress(): { running: boolean; total: number; completed: number; startedAt: number } {
  return { running: false, total: 0, completed: 0, startedAt: 0 };
}

// URL 脱敏透传（纯字符串处理，CF 也用得到）
export function maskProxyUrl(url: string): string {
  return url;
}
export function normalizeProxyStatKey(url: string): string {
  return url;
}
export function proxyStatKey(url: string): string {
  return url;
}

// 配置校验：永远不合法（CF 上不可用）
export type ProxyConfigValidation = { ok: true } | { ok: false; error: string };
export function validateUpstreamProxyConfig(_raw: string): ProxyConfigValidation {
  return { ok: false, error: "Cloudflare 部署不支持出站代理" };
}

export function getHealthCheckIntervalMin(): number {
  return 5;
}

// 拉取代理组：永远空结果
export interface PullProxyGroupsOptions {
  force?: boolean;
  source?: string;
}
export async function pullProxyGroups(_options?: PullProxyGroupsOptions): Promise<{ added: number; updated: number; removed: number; groups: string[] }> {
  return { added: 0, updated: 0, removed: 0, groups: [] };
}

// 评分权重（保留算法占位，CF 永远不被调用）
export interface ProxyTrafficStat {
  url: string;
  successCount: number;
  failCount: number;
  totalCount: number;
  avgLatencyMs: number;
  lastUsedAt: number;
  consecutiveFails: number;
  cooldownUntil: number;
}
export function availabilityWeight(_stat: ProxyTrafficStat | undefined): number {
  return 0;
}
export function latencyWeight(_latencyMs: number, _minLatencyMs: number): number {
  return 0;
}

// 选代理：永远返回 null（不代理）
export interface UpstreamProxySelection {
  url: string | null;
  reason: string;
}
export async function getUpstreamProxy(_options?: unknown): Promise<UpstreamProxySelection> {
  return { url: null, reason: "Cloudflare 部署不支持出站代理" };
}
export async function getUpstreamProxyForKey(_keyId: string, _options?: unknown): Promise<UpstreamProxySelection> {
  return { url: null, reason: "Cloudflare 部署不支持出站代理" };
}

// 流量统计：no-op
export function recordProxyTraffic(_url: string | undefined, _status: number): void {
  // no-op
}
export function isProxyStatDegraded(_stat: ProxyTrafficStat): boolean {
  return false;
}
export function getDegradedProxyUrls(): string[] {
  return [];
}
export async function markProxyFailure(_url: string, _reason?: string): Promise<void> {
  // no-op
}

// 健康检查函数：no-op
export async function runProxyHealthCheck(_options?: unknown): Promise<{ checked: number; healthy: number; unhealthy: number }> {
  return { checked: 0, healthy: 0, unhealthy: 0 };
}
export async function getProxyHealth(_url?: string): Promise<Record<string, { healthy: boolean; lastCheckAt: number; latencyMs: number }>> {
  return {};
}

// 类型导出（编译时消解，runtime 不需要，但 stub 文件需提供占位以满足类型导入）
export type ProxyGroupConfig = { name: string; proxies: string[]; enabled: boolean };
export type ProxyConfig = { url: string; whitelisted: boolean };
export type ProxyHealthEntry = { healthy: boolean; lastCheckAt: number; latencyMs: number };
export type ProxyHealthMap = Record<string, ProxyHealthEntry>;
export type ProxyPullGroupResult = { group: string; added: number; updated: number; removed: number };
export type HealthCheckProgress = { running: boolean; total: number; completed: number; startedAt: number };
