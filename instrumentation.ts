/**
 * Next.js 服务器生命周期钩子（instrumentation）
 *
 * 仅注册 Docker 内部定时器：容器启动时随应用进程自动执行全部定时任务
 * （模型发现 / Key 用量重置 / 日志归档 / 代理健康检查 / 代理列表拉取），
 * 无需外部调度器调用（详见 src/lib/scheduler.ts）。
 *
 * 其他部署平台（Cloudflare / EdgeOne / Vercel / Node 直部署）门控返回，
 * 不启动任何定时逻辑。
 */

export async function register(): Promise<void> {
  const { startScheduler } = await import("./src/lib/scheduler");
  startScheduler();
}