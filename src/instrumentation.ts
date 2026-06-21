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
  }
}
