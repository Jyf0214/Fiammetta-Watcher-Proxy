import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/router";
import { Input, Select, message, Popconfirm, Switch } from "antd";
import { Button } from "@/components/ui/Button";
import { AsyncBoundary } from "@/components/ui/AsyncBoundary";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { ArrowLeft, RefreshCw, Save } from "lucide-react";
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
  parseProxyConfig,
  parseHealthMap,
  parsePoolMap,
  collectGroupUrls,
  parseUrlsText,
  maskProxyUrl,
  buildConfigJson,
  errMsg,
  type GroupFormState,
} from "@/lib/upstream-proxy-ui";

/**
 * 代理组详情/新建页 — 编辑组名、订阅地址、手动代理与绑定平台
 * 路由 /admin/upstream-proxy/[组名]（组名唯一，作为路由 key）
 */
export default function UpstreamProxyGroupPage() {
  const { t } = useTranslation("system");
  const router = useRouter();
  const rawId = router.query.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;
  const isNew = id === "new";

  const [formGroup, setFormGroup] = useState<GroupFormState>({
    id: "",
    name: "",
    sourceUrl: "",
    urlsText: "",
    boundPlatformIds: [],
    enabled: true,
  });
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [checking, setChecking] = useState(false);
  /** 健康检查渐进进度（轮询 GET 刷新；运行中显示「检查中 checked/total」） */
  const [checkProgress, setCheckProgress] = useState<{ checked: number; total: number } | null>(null);
  const checkPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 组件存活标记：轮询 fetch 挂起期间卸载后不再续排（防定时器泄漏） */
  const mountedRef = useRef(true);
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

  const healthMap = parseHealthMap(config?.[HEALTH_KEY]);
  const poolMap = parsePoolMap(config?.[POOL_KEY]);
  const parsed = parseProxyConfig(config?.[CONFIG_KEY]);
  const currentGroup = isNew ? undefined : parsed.groups.find((g) => g.name === id);

  const deployPlatform = process.env.NEXT_PUBLIC_DEPLOY_PLATFORM || "";
  const isDocker = deployPlatform === "docker";

  // 路由 id / 服务器配置值变化时回填表单（渲染期 prev 值比较；值未变时不覆盖未保存的编辑）
  const [prevKey, setPrevKey] = useState<string>("");
  const syncKey = `${id ?? ""}|${config?.[CONFIG_KEY] ?? ""}`;
  if (config && prevKey !== syncKey) {
    setPrevKey(syncKey);
    const g = isNew ? undefined : parsed.groups.find((x) => x.name === id);
    if (g) {
      setFormGroup({
        id: crypto.randomUUID(),
        name: g.name,
        sourceUrl: g.sourceUrl,
        urlsText: g.urls.join("\n"),
        boundPlatformIds: Object.entries(parsed.platformGroup)
          .filter(([, groupName]) => groupName === g.name)
          .map(([pid]) => pid),
        enabled: g.enabled,
      });
    } else if (isNew) {
      setFormGroup({ id: crypto.randomUUID(), name: "", sourceUrl: "", urlsText: "", boundPlatformIds: [], enabled: true });
    }
  }

  /** 全部组 → 表单态（保存/删除时与当前组合并；组顺序保持配置原序） */
  const allGroupsForm = (): GroupFormState[] =>
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

  const saveConfig = async (groupsForm: GroupFormState[], successKey: string) => {
    const result = buildConfigJson(groupsForm, parsed.platformIds, parsed.healthCheckUrl ?? "");
    if (!result.ok) {
      message.error(t(VALIDATION_KEYS[result.error]));
      return false;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: CONFIG_KEY, value: result.value }),
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        mutate();
        message.success(t(successKey));
        return true;
      }
      message.error(errMsg(data, t("common:error")));
      return false;
    } catch {
      message.error(t("common:error"));
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const handleSave = async () => {
    const name = formGroup.name.trim();
    // 新建组追加到末尾；编辑组在原位置替换（其余组原样保留）
    const merged = isNew
      ? [...allGroupsForm(), formGroup]
      : allGroupsForm().map((g) => (g.name === id ? formGroup : g));
    const ok = await saveConfig(merged, "upstreamProxyGroupSaved");
    if (ok && name) {
      router.replace(`/admin/upstream-proxy/${encodeURIComponent(name)}`);
      // 保存后立即拉取订阅源并验证代理连通性（仅 Docker），
      // 不等 cron 周期；失败不阻断保存成功的提示
      if (isDocker) {
        void autoVerifyAfterSave(merged);
      }
    }
  };

  /** 保存后自动拉取 + 健康检查：有订阅地址先拉取，拉取完成后再探测连通性。
   *  跳过 ensureSaved 守卫：刚保存完成，配置与表单一致；且本轮 config 状态
   *  尚未反映 mutate 后的新值，直接比较会误报「请先保存」 */
  const autoVerifyAfterSave = async (merged: GroupFormState[]) => {
    const hasSourceUrl = merged.some((g) => g.sourceUrl.trim().length > 0);
    const hasCandidate = hasSourceUrl || merged.some((g) => g.urlsText.trim().length > 0);
    if (hasSourceUrl) await pullProxyGroupsNow(true);
    if (hasCandidate) await checkProxyHealthNow(true);
  };

  /** 手动触发拉取/检查前确认表单与已保存配置一致，避免结果与页面显示对不上。
   *  比较构造与 handleSave 相同（编辑中的组替换到对应位置），
   *  否则 allGroupsForm 全派生自已保存配置，恒等比较恒真、守卫失效 */
  const ensureSaved = (): boolean => {
    const saved = config?.[CONFIG_KEY];
    const merged = isNew
      ? [...allGroupsForm(), formGroup]
      : allGroupsForm().map((g) => (g.name === id ? formGroup : g));
    const result = buildConfigJson(merged, parsed.platformIds, parsed.healthCheckUrl ?? "");
    if (!result.ok || result.value !== saved) {
      message.warning(t("upstreamProxySaveFirst"));
      return false;
    }
    return true;
  };

  /** 立即拉取订阅源（手动按钮与「保存后自动拉取」共用）；
   *  拉取针对全部配置了订阅地址的组，成功后刷新配置与健康数据 */
  const pullProxyGroupsNow = async (skipEnsure = false) => {
    if (!skipEnsure && !ensureSaved()) return;
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

  /** 立即健康检查（手动按钮与「保存后自动验证」共用）：POST 后台启动后轮询
   *  GET 渐进刷新「检查中 X/Y」（每批写库后 mutate 同步健康数据） */
  const checkProxyHealthNow = async (skipEnsure = false) => {
    if (!skipEnsure && !ensureSaved()) return;
    setChecking(true);
    try {
      const res = await fetch("/api/admin/upstream-proxy/health", { method: "POST" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        void pollHealthProgress();
      } else {
        message.error(errMsg(data, t("common:error")));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setChecking(false);
    }
  };

  /** 轮询健康检查进度：GET 渐进返回 { progress }，running=false 且已启动过
   *  （total>0）视为完成；无候选（total=0）静默停止；轮询上限 60 次兜底 */
  const pollHealthProgress = async (attempt = 0): Promise<void> => {
    if (!mountedRef.current) return;
    try {
      const res = await fetch("/api/admin/upstream-proxy/health");
      const data: Record<string, any> = await res.json();
      if (!data.success) return;
      mutate();
      const progress = data.data?.progress as { running: boolean; total: number; checked: number } | undefined;
      if (!progress || progress.running) {
        if (progress?.running && progress.total > 0) {
          setCheckProgress({ checked: progress.checked, total: progress.total });
        }
        if (attempt + 1 >= 60) {
          // 超限兜底停止：清除指示器避免残留「检查中」
          setCheckProgress(null);
          return;
        }
        checkPollTimer.current = setTimeout(() => void pollHealthProgress(attempt + 1), 2000);
        return;
      }
      // running=false：total>0 = 检查完成；total=0 = 无候选可检查（合法状态，不提示）
      setCheckProgress(null);
      if (progress.total > 0) message.success(t("upstreamProxyHealthDone"));
    } catch {
      // 轮询失败静默重试（检查仍在后台继续，多等一轮）
      if (attempt + 1 >= 60) {
        setCheckProgress(null);
        return;
      }
      checkPollTimer.current = setTimeout(() => void pollHealthProgress(attempt + 1), 2000);
    }
  };

  const handleDelete = async () => {
    if (isNew) return;
    setDeleting(true);
    try {
      const ok = await saveConfig(
        allGroupsForm().filter((g) => g.name !== id),
        "upstreamProxyGroupDeleted"
      );
      if (ok) router.push("/admin/upstream-proxy");
    } finally {
      setDeleting(false);
    }
  };

  const platformOptions = (platforms ?? []).map((p) => ({ label: p.name, value: p.id }));

  /** 组内候选代理（已保存配置的拉取池 ∪ 表单当前手动代理）与健康摘要；
   *  统计基于表单当前值（组名/手动代理），编辑后立即反映，不与标题脱节 */
  const groupUrls = collectGroupUrls(
    currentGroup ? (poolMap[currentGroup.name] ?? []) : [],
    parseUrlsText(formGroup.urlsText)
  );
  const summary: ProxyGroupSummary = {
    name: formGroup.name || currentGroup?.name || (isNew ? "" : id ?? ""),
    sourceUrl: formGroup.sourceUrl || currentGroup?.sourceUrl || "",
    proxyCount: groupUrls.length,
    okCount: groupUrls.filter((u) => healthMap[u]?.status === "ok").length,
    failCount: groupUrls.filter((u) => healthMap[u]?.status === "fail").length,
    enabled: formGroup.enabled,
  };

  /** 组列表行数据（侧栏与返回条摘要共用） */
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

  // 加载失败且无数据：渲染错误态
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

  const formGroupClass = "rounded-2xl bg-zinc-50 dark:bg-zinc-800/50 p-4";
  const groupTitleClass = "text-xs font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-3";

  /** 组内代理列表（只读健康视图） */
  const proxyListView = (
    <div className={formGroupClass}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
          {t("upstreamProxyGroupProxies")}
        </h3>
        {isDocker && (
          <div className="flex items-center gap-2">
            {checkProgress && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400 shrink-0">
                {t("upstreamProxyHealthChecking", checkProgress)}
              </span>
            )}
            <Button
              variant="default"
              size="sm"
              onClick={() => void pullProxyGroupsNow()}
              loading={pulling}
              icon={<RefreshCw size={14} />}
              disabled={!currentGroup?.sourceUrl}
            >
              {t("upstreamProxyPullNow")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => void checkProxyHealthNow()}
              loading={checking}
              icon={<RefreshCw size={14} />}
              disabled={groupUrls.length === 0}
            >
              {t("upstreamProxyCheckNow")}
            </Button>
          </div>
        )}
      </div>
      {groupUrls.length === 0 ? (
        <p className="text-xs text-zinc-400">{t("upstreamProxyGroupEmpty")}</p>
      ) : (
        <ul className="space-y-1.5">
          {groupUrls.map((url) => {
            const entry = healthMap[url];
            const status = entry?.status ?? "none";
            return (
              <li key={url} className="flex items-center gap-2 text-xs">
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
          })}
        </ul>
      )}
    </div>
  );

  /** 编辑表单（基本信息 / 手动代理 / 绑定平台） */
  const editForm = (
    <div className="flex flex-col gap-4">
      <div className={formGroupClass}>
        <h3 className={groupTitleClass}>{t("upstreamProxyGroupBasic")}</h3>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {t("upstreamProxyGroupEnabledLabel")}
              </label>
              <p className="text-xs text-zinc-400 mt-0.5">{t("upstreamProxyGroupEnabledHelp")}</p>
            </div>
            <Switch
              checked={formGroup.enabled}
              onChange={(checked) => setFormGroup({ ...formGroup, enabled: checked })}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              {t("upstreamProxyGroupNameLabel")}
            </label>
            <Input
              value={formGroup.name}
              onChange={(e) => setFormGroup({ ...formGroup, name: e.target.value })}
              placeholder={t("upstreamProxyGroupNamePlaceholder")}
              allowClear
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
              {t("upstreamProxySourceUrlLabel")}
            </label>
            <Input
              value={formGroup.sourceUrl}
              onChange={(e) => setFormGroup({ ...formGroup, sourceUrl: e.target.value })}
              placeholder={t("upstreamProxySourceUrlPlaceholder")}
              allowClear
            />
            <p className="text-xs text-zinc-400 mt-1">{t("upstreamProxySourceUrlHelp")}</p>
          </div>
        </div>
      </div>

      <div className={formGroupClass}>
        <h3 className={groupTitleClass}>{t("upstreamProxyManualUrlsLabel")}</h3>
        <Input.TextArea
          value={formGroup.urlsText}
          onChange={(e) => setFormGroup({ ...formGroup, urlsText: e.target.value })}
          placeholder={"127.0.0.1:7890\nhttp://127.0.0.1:7891"}
          rows={4}
          allowClear
        />
        <p className="text-xs text-zinc-400 mt-1">{t("upstreamProxyManualUrlsHelp")}</p>
      </div>

      <div className={formGroupClass}>
        <h3 className={groupTitleClass}>{t("upstreamProxyGroupBoundPlatforms")}</h3>
        <Select
          mode="multiple"
          value={formGroup.boundPlatformIds}
          onChange={(v: string[]) => setFormGroup({ ...formGroup, boundPlatformIds: v })}
          options={platformOptions}
          placeholder={t("upstreamProxyGroupBoundPlatformsPlaceholder")}
          allowClear
          className="w-full"
          maxTagCount={3}
        />
        <p className="text-xs text-zinc-400 mt-1">{t("upstreamProxyGroupBoundPlatformsHelp")}</p>
      </div>

      {proxyListView}

      <Button variant="primary" size="sm" onClick={handleSave} loading={submitting} icon={<Save size={14} />}>
        {t("common:save")}
      </Button>

      {!isNew && (
        <div className="text-center">
          <Popconfirm
            title={t("upstreamProxyRemoveGroup")}
            description={t("upstreamProxyDeleteGroupConfirm")}
            onConfirm={handleDelete}
            okButtonProps={{ danger: true }}
          >
            <button type="button" disabled={deleting} className="text-xs text-red-500 hover:text-red-600 disabled:opacity-50">
              {t("upstreamProxyRemoveGroup")}
            </button>
          </Popconfirm>
        </div>
      )}
    </div>
  );

  return (
    <AdminLayout>
      <div className="flex flex-col lg:flex-row h-full">
        {/* 左侧：桌面端代理组列表栏 */}
        <div className="hidden lg:block w-[340px] shrink-0 border-r border-zinc-100 dark:border-zinc-800 bg-white dark:bg-zinc-900 rounded-2xl overflow-hidden mr-6">
          <ProxyGroupList
            groups={summaries}
            loading={isValidating}
            activeName={isNew ? undefined : id}
            className="h-[calc(100vh-100px)] overflow-y-auto"
          />
        </div>

        {/* 右侧：详情主体 */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* 移动端返回条（sticky 吸顶：top-16 对齐 64px 顶栏下缘、z-30 低于面包屑；-mx-4 -mt-4 抵消 AdminLayout p-4） */}
          <div className="lg:hidden sticky top-16 z-30 bg-white/95 dark:bg-zinc-900/95 backdrop-blur -mx-4 -mt-4 px-4 py-2.5 h-[52px] flex items-center justify-between border-b border-zinc-200/80 dark:border-zinc-800">
            <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
              <button
                onClick={() => router.push("/admin/upstream-proxy")}
                className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 shrink-0"
                aria-label={t("common:back")}
              >
                <ArrowLeft size={18} />
              </button>
              <span className="text-[15px] font-bold text-zinc-900 dark:text-zinc-100 truncate">
                {isNew ? t("upstreamProxyNewGroup") : summary.name || "…"}
              </span>
            </div>
            {!isNew && summary.name && (
              <span className="shrink-0 flex items-center gap-1.5 text-xs text-zinc-400">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    summary.proxyCount === 0
                      ? "bg-zinc-300 dark:bg-zinc-600"
                      : summary.failCount > 0
                        ? "bg-rose-500"
                        : summary.okCount > 0
                          ? "bg-emerald-500"
                          : "bg-zinc-300 dark:bg-zinc-600"
                  }`}
                />
                {summary.proxyCount}
              </span>
            )}
          </div>

          {/* 详情主体 */}
          <div className="flex-1 min-w-0 w-full max-w-2xl mx-auto pt-4 lg:pt-0 pb-10">
            {!isNew && !currentGroup ? (
              <div className="flex flex-col items-center gap-3 py-16 text-zinc-400">
                <span className="text-sm">{t("upstreamProxyGroupNotFound")}</span>
                <Button variant="default" size="sm" onClick={() => router.push("/admin/upstream-proxy")}>
                  {t("common:back")}
                </Button>
              </div>
            ) : (
              <>
                {/* 头部：组名 + 订阅地址 + 健康摘要 */}
                <div className="flex items-center gap-3 mb-5">
                  <span className="w-12 h-12 shrink-0 flex items-center justify-center rounded-2xl bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 text-base font-bold">
                    {(summary.name || "?").trim().slice(0, 2).toUpperCase()}
                  </span>
                  <div className="flex-1 min-w-0">
                    <h1 className="text-base font-bold truncate">
                      {isNew ? t("upstreamProxyNewGroup") : summary.name || "…"}
                    </h1>
                    {!isNew && (
                      <div className="flex items-center gap-1.5 mt-1">
                        <span
                          className={`inline-block h-2 w-2 rounded-full shrink-0 ${
                            summary.proxyCount === 0
                              ? "bg-zinc-300 dark:bg-zinc-600"
                              : summary.failCount > 0
                                ? "bg-rose-500"
                                : summary.okCount > 0
                                  ? "bg-emerald-500"
                                  : "bg-zinc-300 dark:bg-zinc-600"
                          }`}
                        />
                        <span className="text-[11px] text-zinc-400">
                          {t("upstreamProxyHealthStats", {
                            total: summary.proxyCount,
                            ok: summary.okCount,
                            fail: summary.failCount,
                            none: summary.proxyCount - summary.okCount - summary.failCount,
                          })}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {editForm}
              </>
            )}
          </div>
        </div>
      </div>
    </AdminLayout>
  );
}