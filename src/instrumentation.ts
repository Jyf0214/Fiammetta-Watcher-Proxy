/**
 * Next.js Instrumentation — 服务端启动时自动初始化管理员账户
 * 仅在 Node.js 运行时执行，不在 Edge runtime 中运行
 *
 * 当未配置 DATABASE_URL 时，跳过所有数据库相关初始化，
 * 引导用户通过 /setup 页面进行配置
 *
 * 支持从配置文件 (data/db-config.json) 读取数据库配置
 */
export async function register() {
  // 仅在 Node.js 运行时执行（非 Edge）
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // 从配置文件加载数据库配置（优先级：环境变量 > 配置文件）
    try {
      const { loadConfigFromEnv } = await import("./lib/config");
      loadConfigFromEnv();
    } catch (error) {
      console.error("[instrumentation] 配置文件加载失败:", error);
    }

    // 如果未配置 DATABASE_URL，跳过所有数据库相关初始化
    if (!process.env.DATABASE_URL) {
      console.log(
        "[instrumentation] 未配置 DATABASE_URL，跳过数据库相关初始化，等待用户通过 /setup 页面配置"
      );
      return;
    }

    try {
      const { initializeAdmin } = await import("./services/init");
      await initializeAdmin();
    } catch (error) {
      console.error("[instrumentation] 管理员初始化失败:", error);
    }

    // 从数据库同步熔断器状态到内存（解决重启后状态丢失问题）
    try {
      const { syncCircuitBreakersFromDatabase } = await import(
        "./lib/circuit-breaker"
      );
      await syncCircuitBreakersFromDatabase();
    } catch (error) {
      console.error("[instrumentation] 熔断器状态同步失败:", error);
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

    // 启动速率限制器过期窗口清理定时器（防止内存无限增长）
    try {
      const { startRateLimitCleanup } = await import("./lib/rate-limiter");
      startRateLimitCleanup();
    } catch (error) {
      console.error("[instrumentation] 速率限制器清理服务启动失败:", error);
    }

    // 启动日志归档调度器（每天凌晨将 30 天前的详细日志聚合为统计数据）
    try {
      const { startLogArchiver } = await import("./lib/log-archiver");
      startLogArchiver();
    } catch (error) {
      console.error("[instrumentation] 日志归档服务启动失败:", error);
    }
  }
}
