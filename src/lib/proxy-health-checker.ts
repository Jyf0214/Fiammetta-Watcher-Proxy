/**
 * 代理健康检查后台服务
 *
 * 定期测试所有已启用代理的可用性：
 * - 通过代理向目标平台发送轻量 HEAD 请求
 * - 一次失败即封禁，封禁时长递增：首次 15 分钟，第二次 5 小时，第三次起 24 小时
 * - 封禁到期后进入"未使用"状态（不可用于请求），需自动测试通过才恢复正常
 * - 测试间隔 15 分钟，封禁中的代理跳过检测
 *
 * 代理三种状态：
 * - healthy（正常）：可用
 * - down + cooldownEnd > now（封禁）：不可用，等待封禁到期
 * - down + cooldownEnd <= now（未使用）：封禁已到期，等待自动测试恢复
 * - degraded（恢复中）：自动测试通过后渐进恢复，尚未完全可信
 */

import { prisma } from "./prisma";

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 分钟
const TEST_TIMEOUT_MS = 10_000; // 单次测试超时 10 秒

/**
 * 根据封禁次数计算封禁时长
 *
 * 第 1 次封禁：15 分钟
 * 第 2 次封禁：5 小时
 * 第 3 次及以后：24 小时
 */
function getBanDurationMs(banCount: number): number {
  if (banCount <= 1) return 15 * 60 * 1000; // 15 分钟
  if (banCount === 2) return 5 * 60 * 60 * 1000; // 5 小时
  return 24 * 60 * 60 * 1000; // 24 小时
}

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
      // 跳过仍在封禁冷却期内的代理（封禁状态）
      if (proxy.cooldownEnd && proxy.cooldownEnd > now) continue;

      const healthy = await testProxy(proxy.address, targetUrl);

      if (healthy) {
        // 测试通过
        if (proxy.status === "down") {
          // "未使用"状态（封禁已到期）→ 恢复为 degraded（渐进恢复，尚不完全可信）
          await prisma.proxy.update({
            where: { id: proxy.id },
            data: { status: "degraded", failCount: 0, cooldownEnd: null },
          });
          console.log(
            `[proxy-health] 代理 ${proxy.id} 自动测试通过: 未使用 → degraded（渐进恢复中）`
          );
        } else if (proxy.status === "degraded") {
          // degraded → healthy（连续两次测试通过，完全恢复）
          await prisma.proxy.update({
            where: { id: proxy.id },
            data: { status: "healthy", failCount: 0 },
          });
          console.log(
            `[proxy-health] 代理 ${proxy.id} 状态恢复: degraded → healthy`
          );
        }
        // healthy 代理测试通过，无需变更
      } else {
        // 测试失败：一次失败即封禁，递增封禁时长
        const newBanCount = proxy.banCount + 1;
        const banDuration = getBanDurationMs(newBanCount);
        const cooldownEnd = new Date(now.getTime() + banDuration);

        await prisma.proxy.update({
          where: { id: proxy.id },
          data: {
            status: "down",
            failCount: 0,
            banCount: newBanCount,
            lastFailAt: now,
            cooldownEnd,
          },
        });

        const durationLabel =
          banDuration <= 15 * 60 * 1000
            ? "15 分钟"
            : banDuration <= 5 * 60 * 60 * 1000
              ? "5 小时"
              : "24 小时";
        console.warn(
          `[proxy-health] 代理 ${proxy.id} 测试失败，封禁 ${durationLabel}（第 ${newBanCount} 次封禁，至 ${cooldownEnd.toISOString()}）`
        );
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
  console.log("[proxy-health] 启动代理健康检查服务，间隔 15 分钟");
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
