import { useState, useEffect, useRef } from "react";
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
  /** 健康检查渐进进度（轮询 GET 刷新；运行中显示「检查中 checked/total」） */
  const [checkProgress, setCheckProgress] = useState<{ checked: number; total: number } | null>(null);
  const checkPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 组件存活标记：轮询 fetch 挂起期间卸载后不再续排（防定时器泄漏） */
  const mountedRef = useRef(true);
  /** 轮询链单飞守卫：任一启动入口（挂载同步/手动检查）只允许一条活动链 */
  const pollChainActive = useRef(false);
  /** 挂载同步一次性标记：检查期间 config 每批变化会重跑挂载 effect，防重复同步 */
  const syncedOnMount = useRef(false);
  const { data: config, error, isLoading, isValidating, mutate } = useApi<Record<string, string>>(
    "/api/admin/config"
  );
  const { data: platforms } = useApi<{ id: string; name: string }[]>("/api/admin/platforms");

  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [error, t]);

  // 组件卸载时停止健康检查轮询
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (checkPollTimer.current) clearTimeout(checkPollTimer.current);
    };
  }, []);

  const deployPlatform = process.env.NEXT_PUBLIC_DEPLOY_PLATFORM || "";
  const isDocker = deployPlatform === "docker";

  // 服务器配置值变化时回填全局字段（渲染期 prev 值比较，避免 effect 内同步 setState；
  // 值未变时不回填，不覆盖未保存的编辑）
  const [prevConfigValue, setPrevConfigValue] = useState<string | undefined>(undefined);
  if (config && prevConfigValue !== config[CONFIG_KEY]) {
    setPrevConfigValue(config[CONFIG_KEY]);
    const parsed = parseProxyConfig(config[CONFIG_KEY]);
    setPlatformIds(parsed.platformIds);
    setCheckUrl(parsed.healthCheckUrl ?? "");
  }

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
      enabled: g.enabled,
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
      enabled: g.enabled,
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

  /** 立即健康检查：POST 后台启动后轮询 GET 渐进刷新「检查中 X/Y」
   * （每批写库后 mutate 同步健康数据），running=false 且已启动过视为完成 */
  const checkNow = async () => {
    if (!ensureSaved()) return;
    setChecking(true);
    try {
      const res = await fetch("/api/admin/upstream-proxy/health", { method: "POST" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        void startPolling();
      } else {
        message.error(errMsg(data, t("common:error")));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setChecking(false);
    }
  };

  /** 轮询健康检查进度（与详情页 pollHealthProgress 同逻辑）：
   *  running=true 继续轮询并显示「检查中 X/Y」；running=false 且 total>0 完成；
   *  无候选（无配置/全部组禁用，total=0）静默停止；progress 元组 60s 无变化
   *  （后端任务停滞/丢失）时停止轮询并清指示器，防死循环。
   *  所有终止路径复位 pollChainActive，使后续启动入口可再开新链 */
  const pollHealthProgress = async (lastKey = "", stalled = 0): Promise<void> => {
    if (!mountedRef.current) {
      pollChainActive.current = false;
      return;
    }
    try {
      const res = await fetch("/api/admin/upstream-proxy/health");
      const data: Record<string, any> = await res.json();
      if (!data.success) {
        // 接口失败（如瞬时 500/会话过期）：与 catch 分支一致按停滞累计，
        // 后端检查仍在继续，多等一轮；连续失败才终止并清指示器
        if (stalled + 1 >= 30) {
          pollChainActive.current = false;
          setCheckProgress(null);
          return;
        }
        checkPollTimer.current = setTimeout(() => void pollHealthProgress(lastKey, stalled + 1), 2000);
        return;
      }
      mutate();
      const progress = data.data?.progress as { running: boolean; total: number; checked: number } | undefined;
      if (!progress || progress.running) {
        if (progress?.running && progress.total > 0) {
          setCheckProgress({ checked: progress.checked, total: progress.total });
        }
        const key = `${progress?.running ?? "?"}|${progress?.total ?? "?"}|${progress?.checked ?? "?"}`;
        const nextStalled = key === lastKey ? stalled + 1 : 0;
        if (nextStalled >= 30) {
          // 60s 无任何进展（后端任务停滞）→ 停止轮询并清除指示器
          setCheckProgress(null);
          pollChainActive.current = false;
          return;
        }
        checkPollTimer.current = setTimeout(() => void pollHealthProgress(key, nextStalled), 2000);
        return;
      }
      // running=false：total>0 = 检查完成；total=0 = 无候选可检查（合法状态，不提示）
      setCheckProgress(null);
      pollChainActive.current = false;
      if (progress.total > 0) message.success(t("upstreamProxyHealthDone"));
    } catch {
      // 轮询失败按停滞累计（检查仍在后台继续，多等一轮）
      if (stalled + 1 >= 30) {
        setCheckProgress(null);
        pollChainActive.current = false;
        return;
      }
      checkPollTimer.current = setTimeout(() => void pollHealthProgress(lastKey, stalled + 1), 2000);
    }
  };

  /** 轮询链单飞入口：挂载同步/手动检查统一走此启动，已有活动链时不再重复启动
   *  （检查期间 config 每批变化会重跑挂载 effect，无此守卫将叠加多条并行链） */
  const startPolling = (): void => {
    if (pollChainActive.current) return;
    pollChainActive.current = true;
    void pollHealthProgress();
  };

  // 挂载/配置就绪后同步进行中的健康检查：页面刷新后立即恢复「检查中 X/Y」，
  // 无需重新点击检查（进度在服务端进程内，不随刷新丢失）。
  // syncedOnMount 一次性标记：检查期间 config 每批变化（轮询 mutate 拉新数据）
  // 会重跑本 effect，只允许首次同步（活动链由 startPolling 单飞守卫兜底）
  useEffect(() => {
    if (!isDocker || !config || syncedOnMount.current) return;
    void (async () => {
      try {
        const res = await fetch("/api/admin/upstream-proxy/health");
        const data: Record<string, any> = await res.json();
        if (!data.success) return;
        if (data.data?.progress?.running) void startPolling();
      } catch {
        // 静默：接口异常时保持无进度状态；不置位标记，config 变化时重试同步
        return;
      }
      // fetch 成功即视为已同步（无论是否在跑），此后 config 每批变化不再重复触发
      syncedOnMount.current = true;
    })();
    // startPolling/pollHealthProgress 为组件内函数，仅需在挂载/配置就绪时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDocker, config]);

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
                  {checkProgress && (
                    <span className="ml-2 text-emerald-600 dark:text-emerald-400">
                      {t("upstreamProxyHealthChecking", checkProgress)}
                    </span>
                  )}
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