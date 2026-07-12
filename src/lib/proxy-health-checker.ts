/**
 * 代理健康检查后台服务
 *
 * 定期测试所有已启用代理的可用性：
 * - 通过代理向目标平台发送轻量 HEAD 请求
 * - 连续失败 3 次后封禁 30 分钟
 * - 封禁到期后自动恢复为 half-open 状态重新测试
 * - 测试间隔 5 分钟
 *
 * 代理不再绑定平台，健康检查使用第一个启用的平台作为测试目标。
 */

import { prisma } from "./prisma";

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
const FAILURE_THRESHOLD = 2; // 连续失败 2 次触发降级，3 次触发封禁
const BAN_DURATION_MS = 30 * 60 * 1000; // 封禁 30 分钟
const TEST_TIMEOUT_MS = 10_000; // 单次测试超时 10 秒

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * 解析代理地址，提取协议、认证信息、主机和端口
 */
function parseProxyAddress(address: string): {
  protocol: string;
  hostname: string;
  port: number;
  username?: string;
  password?: string;
} | null {
  try {
    const url = new URL(address);
    const protocol = url.protocol.replace(":", "");
    if (!["http", "https", "socks5"].includes(protocol)) return null;
    return {
      protocol,
      hostname: url.hostname,
      port: url.port ? parseInt(url.port, 10) : protocol === "socks5" ? 1080 : 80,
      username: url.username || undefined,
      password: url.password || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 通过代理发送轻量测试请求
 */
async function testProxy(
  proxyAddress: string,
  targetUrl: string
): Promise<boolean> {
  const parsed = parseProxyAddress(proxyAddress);
  if (!parsed) return false;

  try {
    if (parsed.protocol === "socks5") {
      const { SocksProxyAgent } = await import("socks-proxy-agent");
      const agent = new SocksProxyAgent(proxyAddress);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

      try {
        const res = await fetch(targetUrl, {
          // @ts-expect-error agent is for Node.js fetch
          agent,
          signal: controller.signal,
          method: "HEAD",
        });
        clearTimeout(timeoutId);
        return res.ok;
      } catch {
        clearTimeout(timeoutId);
        return false;
      } finally {
        agent.destroy?.();
      }
    } else {
      const { HttpsProxyAgent } = await import("https-proxy-agent");
      const agent = new HttpsProxyAgent(proxyAddress);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);

      try {
        const res = await fetch(targetUrl, {
          // @ts-expect-error agent is for Node.js fetch
          agent,
          signal: controller.signal,
          method: "HEAD",
        });
        clearTimeout(timeoutId);
        return res.ok;
      } catch {
        clearTimeout(timeoutId);
        return false;
      } finally {
        agent.destroy?.();
      }
    }
  } catch {
    return false;
  }
}

/**
 * 执行一轮健康检查
 */
async function runCheck() {
  try {
    const proxies = await prisma.proxy.findMany({
      where: { enabled: true },
    });

    const now = new Date();

    // 随机选择一个启用的平台作为测试目标（避免单一目标导致误判）
    const testPlatforms = await prisma.platform.findMany({
      where: { enabled: true },
      select: { baseUrl: true },
    });
    if (testPlatforms.length === 0) {
      if (proxies.length > 0) {
        console.warn("[proxy-health] 无可用平台，跳过健康检查");
      }
      return;
    }
    const targetPlatform = testPlatforms[Math.floor(Math.random() * testPlatforms.length)];
    const targetUrl = targetPlatform.baseUrl.replace(/\/+$/, "") + "/";

    for (const proxy of proxies) {
      // 跳过仍在封禁冷却期内的代理
      if (proxy.cooldownEnd && proxy.cooldownEnd > now) continue;

      const healthy = await testProxy(proxy.address, targetUrl);

      // 使用事务原子性更新 failCount，防止与请求失败的竞争条件
      await prisma.$transaction(async (tx) => {
        // 重新读取最新状态
        const currentProxy = await tx.proxy.findUnique({
          where: { id: proxy.id },
          select: { failCount: true, status: true },
        });
        if (!currentProxy) return;

        if (healthy) {
          // 渐进式恢复：从 down 恢复时先进入 degraded，而不是直接恢复为 healthy
          if (currentProxy.failCount > 0 || currentProxy.status !== "healthy") {
            const oldStatus = currentProxy.status;
            let newStatus: string;
            let newFailCount: number;

            if (oldStatus === "down") {
              // 从 down 恢复：进入 degraded 状态，failCount 设为 1
              newStatus = "degraded";
              newFailCount = 1;
              console.log(
                `[proxy-health] 代理 ${proxy.id} 从 down 渐进恢复: ${oldStatus} → degraded, failCount: ${newFailCount}`
              );
            } else {
              // 从 degraded 恢复：直接恢复为 healthy
              newStatus = "healthy";
              newFailCount = 0;
              console.log(
                `[proxy-health] 代理 ${proxy.id} 状态恢复: ${oldStatus} → healthy`
              );
            }

            await tx.proxy.update({
              where: { id: proxy.id },
              data: { failCount: newFailCount, status: newStatus, cooldownEnd: null },
            });
          }
        } else {
          const newFailCount = currentProxy.failCount + 1;
          const newStatus =
            newFailCount >= FAILURE_THRESHOLD ? "down" : "degraded";
          const cooldownEnd =
            newFailCount >= FAILURE_THRESHOLD
              ? new Date(now.getTime() + BAN_DURATION_MS)
              : null;

          const oldStatus = currentProxy.status;
          await tx.proxy.update({
            where: { id: proxy.id },
            data: {
              failCount: newFailCount,
              status: newStatus,
              lastFailAt: now,
              cooldownEnd,
            },
          });

          // 状态变更时记录日志
          if (oldStatus !== newStatus) {
            console.warn(
              `[proxy-health] 代理 ${proxy.id} 状态变更: ${oldStatus} → ${newStatus}, failCount: ${newFailCount}`
            );
          }

          if (newFailCount >= FAILURE_THRESHOLD) {
            console.warn(
              `[proxy-health] 代理 ${proxy.id} 连续失败 ${newFailCount} 次，封禁至 ${cooldownEnd?.toISOString()}`
            );
          }
        }
      });
    }
  } catch (err) {
    console.error(
      "[proxy-health] 健康检查异常:",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * 启动代理健康检查后台服务
 *
 * 在首次调用时初始化，后续按固定间隔执行。
 * 可安全多次调用，仅首次生效。
 */
export function startProxyHealthChecker() {
  if (timer) return;
  console.log("[proxy-health] 启动代理健康检查服务，间隔 5 分钟");
  // 首次延迟 30 秒执行，等待系统启动完成
  setTimeout(runCheck, 30_000);
  timer = setInterval(runCheck, CHECK_INTERVAL_MS);
}

/**
 * 停止代理健康检查
 */
export function stopProxyHealthChecker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
