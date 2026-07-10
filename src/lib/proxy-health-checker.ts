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
const FAILURE_THRESHOLD = 3; // 连续失败次数触发封禁
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
        return res.ok || res.status === 404 || res.status === 405;
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
        return res.ok || res.status === 404 || res.status === 405;
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

    // 获取第一个启用的平台作为测试目标
    const testPlatform = await prisma.platform.findFirst({
      where: { enabled: true },
      select: { baseUrl: true },
    });
    if (!testPlatform) {
      if (proxies.length > 0) {
        console.warn("[proxy-health] 无可用平台，跳过健康检查");
      }
      return;
    }
    const targetUrl = testPlatform.baseUrl.replace(/\/+$/, "") + "/";

    for (const proxy of proxies) {
      // 跳过仍在封禁冷却期内的代理
      if (proxy.cooldownEnd && proxy.cooldownEnd > now) continue;

      const healthy = await testProxy(proxy.address, targetUrl);

      if (healthy) {
        // 恢复健康状态
        if (proxy.failCount > 0 || proxy.status !== "healthy") {
          await prisma.proxy.update({
            where: { id: proxy.id },
            data: { failCount: 0, status: "healthy", cooldownEnd: null },
          });
        }
      } else {
        const newFailCount = proxy.failCount + 1;
        const newStatus =
          newFailCount >= FAILURE_THRESHOLD ? "down" : "degraded";
        const cooldownEnd =
          newFailCount >= FAILURE_THRESHOLD
            ? new Date(now.getTime() + BAN_DURATION_MS)
            : null;

        await prisma.proxy.update({
          where: { id: proxy.id },
          data: {
            failCount: newFailCount,
            status: newStatus,
            lastFailAt: now,
            cooldownEnd,
          },
        });

        if (newFailCount >= FAILURE_THRESHOLD) {
          console.warn(
            `[proxy-health] 代理 ${proxy.id} 连续失败 ${newFailCount} 次，封禁至 ${cooldownEnd?.toISOString()}`
          );
        }
      }
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
