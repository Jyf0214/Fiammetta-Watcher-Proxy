/**
 * V1 路由分发器（lite 版）
 *
 * 分发骨架（count_tokens 分支、端点表查询、认证、models 列表/详情）已收敛至
 * proxy-core/v1-route-core.ts（与全量版共用同一实现），本文件仅注入 lite 版
 * 业务链路：proxyV1RequestLite（单次尝试代理）与 router-lite.ts 路由缓存。
 * lite 构建不引入全量版 router/proxy（无评分/熔断/重试代码）。
 */

import { proxyV1RequestLite } from "./proxy-lite";
import {
  refreshCacheLite,
  getPlatformCacheLite,
  getPlatformModelCacheLite,
} from "./router-lite";
import { handleV1RouteCore } from "./proxy-core/v1-route-core";
import type { WorkerEnv } from "./config";

/**
 * 处理 /v1/* 路由请求（lite）
 */
export async function handleV1RouteLite(
  request: Request,
  env: { DB: D1Database; KV: KVNamespace } & WorkerEnv,
  ctx: ExecutionContext
): Promise<Response> {
  return handleV1RouteCore(request, env, ctx, {
    proxyHandler: proxyV1RequestLite,
    refreshCache: refreshCacheLite,
    getPlatformCache: getPlatformCacheLite,
    getPlatformModelCache: getPlatformModelCacheLite,
  });
}
