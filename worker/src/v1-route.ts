/**
 * V1 路由分发器（全量版）
 *
 * 分发骨架（count_tokens 分支、端点表查询、认证、models 列表/详情）已收敛至
 * proxy-core/v1-route-core.ts（与 lite 版共用同一实现），本文件仅注入全量版
 * 业务链路：proxyV1Request（重试/熔断/评分代理）与 router.ts 路由缓存。
 */

import { proxyV1Request } from "./proxy";
import { refreshCache, getPlatformCache, getPlatformModelCache } from "./router";
import { handleV1RouteCore } from "./proxy-core/v1-route-core";
import type { WorkerEnv } from "./config";

// 兼容旧导入路径（测试与外部模块从 ./v1-route 引用端点配置）
export { getEndpointConfig, type ProxyConfig } from "./endpoints";

/**
 * 处理 /v1/* 路由请求（全量版）
 */
export async function handleV1Route(
  request: Request,
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> {
  return handleV1RouteCore(request, env, ctx, {
    proxyHandler: proxyV1Request,
    refreshCache,
    getPlatformCache,
    getPlatformModelCache,
  });
}
