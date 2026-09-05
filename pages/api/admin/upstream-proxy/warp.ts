/**
 * 出站代理 — Cloudflare Warp 启用/停用 API
 *
 * GET    /api/admin/upstream-proxy/warp — 读取当前 warp 配置 + 运行状态
 * PATCH  /api/admin/upstream-proxy/warp — 启用/停用 warp（必传 consent 状态）
 * DELETE /api/admin/upstream-proxy/warp — 停用 warp（清空配置）
 *
 * 仅 Docker 部署生效（warp-cli 仅 Linux 容器内可运行；非 Docker 端 enabled
 * = true 不报错但 startWarpProcess 内部拒绝，业务走直连）
 */

import type { NextApiRequest, NextApiResponse } from "next";
import { getAdminFromRequest } from "@/lib/admin-auth";
import { checkCsrfOrigin } from "@/lib/admin-security";
import { checkAdminRateLimit } from "@/lib/admin-rate-limit";
import {
  readWarpConfig,
  readWarpRuntimeStatus,
  writeWarpConfig,
  isWarpEffectivelyEnabled,
  startWarpProcess,
  stopWarpProcess,
  getWarpProcessPid,
  getWarpSpawnError,
  WARP_PRIVACY_POLICY_VERSION,
  WARP_PRIVACY_POLICY_URL,
  WARP_TERMS_URL,
  type WarpConfig,
} from "@/lib/upstream-proxy-warp";

const CONSENT_REQUIRED_FIELDS = [
  "trafficViaCloudflare",
  "privacyPolicyRead",
] as const;

interface PatchBody {
  enabled?: boolean;
  consent?: {
    trafficViaCloudflare?: boolean;
    privacyPolicyRead?: boolean;
    policyVersion?: string;
    consentedAt?: number;
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const admin = await getAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({ success: false, error: "未授权" });
  }

  // warp 功能仅 Docker 部署生效；其他部署形态直接拒绝 GET 以外的操作
  if (process.env.DEPLOY_PLATFORM !== "docker" && req.method !== "GET") {
    return res
      .status(400)
      .json({ success: false, error: "Cloudflare Warp 仅 Docker 部署可用" });
  }

  try {
    if (req.method === "GET") {
      const config = await readWarpConfig();
      const runtime = await readWarpRuntimeStatus();
      return res.status(200).json({
        success: true,
        data: {
          // 不返回 consentedAt 完整时间戳（秒级 unix），避免泄露用户行为时间；
          // 只返回"是否启用"两个布尔 + privacy policy 链接（前端弹窗用）
          enabled: config?.enabled ?? false,
          effectiveEnabled: isWarpEffectivelyEnabled(config),
          consent: config?.consent ?? null,
          host: config?.host ?? "127.0.0.1",
          port: config?.port ?? 40000,
          // 服务端环境信息（非用户隐私）
          policyVersion: WARP_PRIVACY_POLICY_VERSION,
          privacyPolicyUrl: WARP_PRIVACY_POLICY_URL,
          termsUrl: WARP_TERMS_URL,
          // 进程状态：实际 PID 由本进程 spawn 的 warpProcess 持有（与 DB 状态可能略有差异，
          // DB 状态由 tickWarpHealth 30s 周期回写）
          pid: getWarpProcessPid(),
          dbStatus: runtime
            ? {
                health: runtime.health,
                rssBytes: runtime.rssBytes,
                checkedAt: runtime.checkedAt,
                error: runtime.error,
              }
            : null,
          spawnError: getWarpSpawnError(),
          deployPlatform: process.env.DEPLOY_PLATFORM ?? "",
        },
      });
    }

    if (req.method === "PATCH") {
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;

      const body = (req.body ?? {}) as PatchBody;
      const current = (await readWarpConfig()) ?? {
        enabled: false,
        consent: {
          trafficViaCloudflare: false,
          privacyPolicyRead: false,
          policyVersion: WARP_PRIVACY_POLICY_VERSION,
          consentedAt: 0,
        },
        host: "127.0.0.1",
        port: 40000,
        mode: "socks5" as const,
      };

      const nextEnabled = body.enabled === true;
      const nextConsent = {
        // 启用时必须双勾选 + 政策版本一致；任一缺失视为拒绝启用
        trafficViaCloudflare:
          nextEnabled && body.consent
            ? body.consent.trafficViaCloudflare === true
            : current.consent.trafficViaCloudflare,
        privacyPolicyRead:
          nextEnabled && body.consent
            ? body.consent.privacyPolicyRead === true
            : current.consent.privacyPolicyRead,
        policyVersion: WARP_PRIVACY_POLICY_VERSION,
        consentedAt:
          nextEnabled
            ? Math.floor(Date.now() / 1000)
            : current.consent.consentedAt,
      };

      if (nextEnabled) {
        for (const k of CONSENT_REQUIRED_FIELDS) {
          if (!nextConsent[k]) {
            return res.status(400).json({
              success: false,
              error: `启用 Cloudflare Warp 需勾选「${k === "trafficViaCloudflare" ? "我了解请求会经 Cloudflare 转发" : "我已查看 Cloudflare 隐私政策"}」`,
            });
          }
        }
      }

      const next: Omit<WarpConfig, "updatedAt"> = {
        enabled: nextEnabled,
        consent: nextConsent,
        host: current.host,
        port: current.port,
        mode: "socks5",
      };
      const saved = await writeWarpConfig(next);

      // 触发主进程内 warp 子进程启停（与写库同步执行，失败不阻塞 API 返回）
      let spawnResult: { ok: boolean; error?: string } | null = null;
      if (process.env.DEPLOY_PLATFORM === "docker") {
        if (nextEnabled) {
          spawnResult = await startWarpProcess(saved);
        } else {
          spawnResult = await stopWarpProcess();
        }
      }

      return res.status(200).json({
        success: true,
        data: {
          enabled: saved.enabled,
          effectiveEnabled: isWarpEffectivelyEnabled(saved),
          pid: getWarpProcessPid(),
          spawnResult,
        },
      });
    }

    if (req.method === "DELETE") {
      if (!checkCsrfOrigin(req, res)) return;
      if (!(await checkAdminRateLimit(admin.adminId, res))) return;

      const cleared: Omit<WarpConfig, "updatedAt"> = {
        enabled: false,
        consent: {
          trafficViaCloudflare: false,
          privacyPolicyRead: false,
          policyVersion: WARP_PRIVACY_POLICY_VERSION,
          consentedAt: 0,
        },
        host: "127.0.0.1",
        port: 40000,
        mode: "socks5",
      };
      await writeWarpConfig(cleared);
      let spawnResult: { ok: boolean; error?: string } | null = null;
      if (process.env.DEPLOY_PLATFORM === "docker") {
        spawnResult = await stopWarpProcess();
      }
      return res.status(200).json({ success: true, data: { spawnResult } });
    }

    res.setHeader("Allow", "GET, PATCH, DELETE");
    return res.status(405).json({ success: false, error: "方法不允许" });
  } catch (err) {
    console.error("[warp api] 未捕获异常:", err);
    return res
      .status(500)
      .json({ success: false, error: (err as Error)?.message ?? "内部错误" });
  }
}
