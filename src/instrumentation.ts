/**
 * Next.js Instrumentation — 服务端启动时自动初始化管理员账户
 * 仅在 Node.js 运行时执行，不在 Edge runtime 中运行
 */
export async function register() {
  // 仅在 Node.js 运行时执行（非 Edge）
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { initializeAdmin } = await import("./services/init");
      await initializeAdmin();
    } catch (error) {
      console.error("[instrumentation] 管理员初始化失败:", error);
    }

    // 启动代理健康检查后台服务（定期检测代理可用性，连续失败 3 次自动封禁）
    try {
      const { startProxyHealthChecker } = await import(
        "./lib/proxy-health-checker"
      );
      startProxyHealthChecker();
    } catch (error) {
      console.error("[instrumentation] 代理健康检查服务启动失败:", error);
    }

    // 启动 API Key 用量自动重置调度器（根据 resetPeriod 定期归零 usedTokens）
    try {
      const { startApiKeyResetScheduler } = await import(
        "./lib/api-key-reset"
      );
      startApiKeyResetScheduler();
    } catch (error) {
      console.error("[instrumentation] API Key 重置调度器启动失败:", error);
    }

    // 启动平台模型自动发现服务（定时从各平台 /v1/models 拉取可用模型）
    try {
      const { startModelFetcher } = await import("./lib/model-fetcher");
      startModelFetcher();
    } catch (error) {
      console.error("[instrumentation] 模型拉取服务启动失败:", error);
    }
  }
}
