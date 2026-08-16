import { useState, useEffect } from "react";
import { Input, Select, message } from "antd";
import { Button } from "@/components/ui/Button";
import { AsyncBoundary } from "@/components/ui/AsyncBoundary";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { RefreshCw, Save } from "lucide-react";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import AdminLayout from "@/components/AdminLayout";
import {
  ProxyGroupList,
  type ProxyGroupSummary,
} from "@/components/upstream-proxy/ProxyGroupList";
import { renderHealthText, VALIDATION_KEYS } from "@/components/upstream-proxy/shared";
import {
  CONFIG_KEY,
  POOL_KEY,
  HEALTH_KEY,
  DEFAULT_CHECK_URL,
  parseProxyConfig,
  parseHealthMap,
  parsePoolMap,
  collectGroupUrls,
  maskProxyUrl,
  buildConfigJson,
  errMsg,
  type GroupFormState,
} from "@/lib/upstream-proxy-ui";

/**
 * 出站代理列表页 — 代理组列表 + 全局设置 + 健康面板
 * 整行点击进入独立路由 /admin/upstream-proxy/[组名]（仿平台管理页模式）
 */
export default function UpstreamProxyPage() {
  const { t } = useTranslation("system");
  const [platformIds, setPlatformIds] = useState<string[]>([]);
  const [checkUrl, setCheckUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pulling, setPulling] = useState(false);
  const { data: config, error, isLoading, isValidating, mutate } = useApi<Record<string, string>>(
    "/api/admin/config"
  );
  const { data: platforms } = useApi<{ id: string; name: string }[]>("/api/admin/platforms");

  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [error, t]);

  // 服务器配置值变化时回填全局字段（渲染期 prev 值比较，避免 effect 内同步 setState；
  // 值未变时不回填，不覆盖未保存的编辑）
  const [prevConfigValue, setPrevConfigValue] = useState<string | undefined>(undefined);
  if (config && prevConfigValue !== config[CONFIG_KEY]) {
    setPrevConfigValue(config[CONFIG_KEY]);
    const parsed = parseProxyConfig(config[CONFIG_KEY]);
    setPlatformIds(parsed.platformIds);
    setCheckUrl(parsed.healthCheckUrl ?? "");
  }

  const deployPlatform = process.env.NEXT_PUBLIC_DEPLOY_PLATFORM || "";
  const isDocker = deployPlatform === "docker";

  const healthMap = parseHealthMap(config?.[HEALTH_KEY]);
  const poolMap = parsePoolMap(config?.[POOL_KEY]);
  const parsed = parseProxyConfig(config?.[CONFIG_KEY]);

  /** 组列表行数据：候选代理数 + 健康摘要（拉取池 ∪ 手动代理） */
  const summaries: ProxyGroupSummary[] = parsed.groups.map((g) => {
    const urls = collectGroupUrls(poolMap[g.name] ?? [], g.urls);
    return {
      name: g.name,
      sourceUrl: g.sourceUrl,
      proxyCount: urls.length,
      okCount: urls.filter((u) => healthMap[u]?.status === "ok").length,
      failCount: urls.filter((u) => healthMap[u]?.status === "fail").length,
    };
  });

  /** 当前表单（组数据来自已保存配置，仅全局字段可编辑）→ 配置 JSON */
  const currentFormGroups = (): GroupFormState[] =>
    parsed.groups.map((g) => ({
      id: crypto.randomUUID(),
      name: g.name,
      sourceUrl: g.sourceUrl,
      urlsText: g.urls.join("\n"),
      boundPlatformIds: Object.entries(parsed.platformGroup)
        .filter(([, groupName]) => groupName === g.name)
        .map(([pid]) => pid),
    }));

  const buildCurrent = () => buildConfigJson(currentFormGroups(), platformIds, checkUrl);

  const save = async () => {
    const result = buildCurrent();
    if (!result.ok) {
      message.error(t(VALIDATION_KEYS[result.error]));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: CONFIG_KEY, value: result.value }),
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        mutate();
        message.success(t("upstreamProxySaved"));
      } else {
        message.error(errMsg(data, t("common:error")));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setSaving(false);
    }
  };

  /** 手动触发拉取/检查前确认表单与已保存配置一致，避免结果与页面显示对不上 */
  const ensureSaved = (): boolean => {
    const saved = config?.[CONFIG_KEY];
    const current = buildCurrent();
    if (!current.ok || current.value !== saved) {
      message.warning(t("upstreamProxySaveFirst"));
      return false;
    }
    return true;
  };

  const pullNow = async () => {
    if (!ensureSaved()) return;
    setPulling(true);
    try {
      const res = await fetch("/api/admin/upstream-proxy/pull", { method: "POST" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        mutate();
        const results = (data.data?.results ?? {}) as Record<string, { error?: string }>;
        const failed = Object.values(results).filter((r) => r?.error);
        if (Object.keys(results).length > 0 && failed.length === Object.keys(results).length) {
          message.error(t("upstreamProxyPullFailed"));
        } else if (failed.length > 0) {
          message.warning(t("upstreamProxyPullPartial"));
        } else {
          message.success(t("upstreamProxyPulled"));
        }
      } else {
        message.error(errMsg(data, t("common:error")));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setPulling(false);
    }
  };

  const checkNow = async () => {
    if (!ensureSaved()) return;
    setChecking(true);
    try {
      const res = await fetch("/api/admin/upstream-proxy/health", { method: "POST" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        mutate();
        message.success(t("upstreamProxyHealthDone"));
      } else {
        message.error(errMsg(data, t("common:error")));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setChecking(false);
    }
  };

  // 加载失败且无数据：渲染错误态而非空表单，防止用户误保存空配置覆盖真实配置
  if (error && !config) {
    return (
      <AdminLayout>
        <div className="max-w-2xl mx-auto p-4 lg:p-6">
          <AsyncBoundary isLoading={false} error={error}>
            <></>
          </AsyncBoundary>
        </div>
      </AdminLayout>
    );
  }

  if (isLoading && !config) {
    return (
      <AdminLayout>
        <div className="max-w-2xl mx-auto p-4 lg:p-6">
          <AsyncBoundary isLoading error={null}>
            <></>
          </AsyncBoundary>
        </div>
      </AdminLayout>
    );
  }

  const platformOptions = (platforms ?? []).map((p) => ({ label: p.name, value: p.id }));

  /** 健康面板统计：全部组候选代理的 ok/fail/未检查计数 */
  const allHealthUrls = parsed.groups.flatMap((g) => collectGroupUrls(poolMap[g.name] ?? [], g.urls));
  const healthStats = {
    total: allHealthUrls.length,
    ok: allHealthUrls.filter((u) => healthMap[u]?.status === "ok").length,
    fail: allHealthUrls.filter((u) => healthMap[u]?.status === "fail").length,
    none: allHealthUrls.filter((u) => !healthMap[u]).length,
  };

  return (
    <AdminLayout>
      <div className="max-w-2xl mx-auto">
        <div
          className={`mb-3 rounded-lg px-3 py-2 text-xs ${
            isDocker
              ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400"
              : "bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400"
          }`}
        >
          {t("upstreamProxyPlatform")}：{deployPlatform || "—"}。
          {isDocker ? t("upstreamProxyActive") : t("upstreamProxyNotActive")}
        </div>

        <ProxyGroupList
          groups={summaries}
          loading={isValidating}
          className="rounded-xl border border-zinc-200/80 dark:border-zinc-800 overflow-hidden"
        />

        {/* 全局设置：代理应用范围 + 健康检查地址（组配置在各组详情页编辑） */}
        <div className="mt-4 rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
          <h3 className="text-xs font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-3">
            {t("upstreamProxyGlobalSettings")}
          </h3>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {t("upstreamProxyPlatformsLabel")}
              </label>
              <Select
                mode="multiple"
                value={platformIds}
                onChange={(v: string[]) => setPlatformIds(v)}
                options={platformOptions}
                placeholder={t("upstreamProxyPlatformsPlaceholder")}
                allowClear
                className="w-full"
                maxTagCount={4}
              />
              <p className="text-xs text-zinc-400 mt-1">{t("upstreamProxyPlatformsHelp")}</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {t("upstreamProxyCheckUrlLabel")}
              </label>
              <Input
                value={checkUrl}
                onChange={(e) => setCheckUrl(e.target.value)}
                placeholder={DEFAULT_CHECK_URL}
                allowClear
              />
              <p className="text-xs text-zinc-400 mt-1">{t("upstreamProxyCheckUrlHelp")}</p>
            </div>
          </div>
          <Button variant="primary" size="sm" onClick={save} loading={saving} icon={<Save size={14} />} className="mt-4">
            {t("common:save")}
          </Button>
        </div>

        {/* 健康面板：仅 Docker 部署可用（拉取/检查为运行时操作） */}
        {isDocker && (
          <div className="mt-4 rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {t("upstreamProxyHealthTitle")}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  onClick={pullNow}
                  loading={pulling}
                  icon={<RefreshCw size={14} />}
                  disabled={parsed.groups.length === 0}
                >
                  {t("upstreamProxyPullNow")}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={checkNow}
                  loading={checking}
                  icon={<RefreshCw size={14} />}
                  disabled={parsed.groups.length === 0}
                >
                  {t("upstreamProxyCheckNow")}
                </Button>
              </div>
            </div>
            {parsed.groups.length === 0 ? (
              <p className="text-xs text-zinc-400">{t("upstreamProxyHealthEmpty")}</p>
            ) : (
              <>
                <p className="text-xs text-zinc-400 mb-2">
                  {t("upstreamProxyHealthStats", healthStats)}
                </p>
                <ul className="space-y-1.5">
                  {parsed.groups.flatMap((g) => {
                    const groupUrls = collectGroupUrls(poolMap[g.name] ?? [], g.urls);
                    return groupUrls.map((url) => {
                      const entry = healthMap[url];
                      const status = entry?.status ?? "none";
                      return (
                        <li key={`${g.name}:${url}`} className="flex items-center gap-2 text-xs">
                          <span
                            className={`inline-block h-2 w-2 rounded-full shrink-0 ${
                              status === "ok"
                                ? "bg-emerald-500"
                                : status === "fail"
                                  ? "bg-rose-500"
                                  : "bg-zinc-300 dark:bg-zinc-600"
                            }`}
                          />
                          <span className="font-mono text-zinc-700 dark:text-zinc-300 truncate min-w-0 flex-1">
                            {maskProxyUrl(url)}
                          </span>
                          <span className="ml-auto shrink-0 text-zinc-400 text-right">
                            {renderHealthText(status, entry, t)}
                          </span>
                        </li>
                      );
                    });
                  })}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </AdminLayout>
  );
}