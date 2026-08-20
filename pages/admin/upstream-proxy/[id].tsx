import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/router";
import { Input, InputNumber, Select, Alert, message, Popconfirm, Switch } from "antd";
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
  PROXY_PULL_INTERVAL_RANGE,
  DEFAULT_PULL_INTERVAL_MIN,
  parseProxyConfig,
  parseHealthMap,
  parsePoolMap,
  collectGroupUrls,
  parseUrlsText,
  displayProxyUrl,
  proxyStatKey,
  buildConfigJson,
  sumMaskedStats,
  formatChecked,
  errMsg,
  type GroupFormState,
  type ParsedConfig,
} from "@/lib/upstream-proxy-ui";

/** 安全上下文（HTTPS/localhost）外 crypto.randomUUID 不存在——HTTP 局域网访问
 * Docker 后台时渲染期调用直接 TypeError 白屏；组身份是 name，id 纯装饰，用兜底生成 */
const genId = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** 统计 API 返回的单代理分类计数（前端展示侧简化聚合） */
interface ProxyTrafficStatUI {
  total: number;
  ok: number;
  err429: number;
  /** 401/403/5xx/其他 合并计数 */
  errOther: number;
  availability: number;
}

/** 统计 API 原始返回形状（pages/api/admin/upstream-proxy/stats.ts） */
interface ProxyTrafficStatsApi {
  total: number;
  ok: number;
  err429: number;
  err401: number;
  err403: number;
  err5xx: number;
  other: number;
  availability: number;
}

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
    autoRefresh: true,
    refreshIntervalMin: null,
  });
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [checking, setChecking] = useState(false);
  /** 健康检查渐进进度（轮询 GET 刷新；运行中显示「检查中 checked/total」） */
  const [checkProgress, setCheckProgress] = useState<{ checked: number; total: number } | null>(null);
  /** 按代理聚合的真实请求统计（stats API；url → 分类计数） */
  const [trafficStats, setTrafficStats] = useState<Record<string, ProxyTrafficStatUI> | null>(null);
  /** 当前统计降权（路由已跳过）的代理（脱敏键列表，stats API 同进程读取） */
  const [degradedUrls, setDegradedUrls] = useState<string[]>([]);
  /** 统计元信息：窗口小时数 + 最近拉取/检查时间（秒级 unix） */
  const [statsMeta, setStatsMeta] = useState<{
    hours: number;
    poolUpdatedAt: number | null;
    lastHealthAt: number | null;
  }>({ hours: 24, poolUpdatedAt: null, lastHealthAt: null });
  const [statsLoading, setStatsLoading] = useState(false);
  /** 设备级禁用状态（stats API 下发）：all=整体禁用、health=仅定时健康检查禁用、null=正常 */
  const [proxyDisabled, setProxyDisabled] = useState<"all" | "health" | null>(null);
  const checkPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 组件存活标记：轮询 fetch 挂起期间卸载后不再续排（防定时器泄漏） */
  const mountedRef = useRef(true);
  /** 轮询链单飞守卫：任一启动入口（挂载同步/手动检查/保存后自动验证）只允许一条活动链 */
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

  /** 解析 stats API 响应为前端展示结构并写入状态（错误分类合并为 errOther：
   *  401/403/5xx/其他；调用方须保证仅在异步回调中调用，避免渲染期同步 setState） */
  const applyStats = (data: unknown): void => {
    const body = data as
      | {
          success?: boolean;
          data?: {
            hours?: number;
            poolUpdatedAt?: number | null;
            lastHealthAt?: number | null;
            proxyDisabled?: "all" | "health" | null;
            stats?: Record<string, ProxyTrafficStatsApi>;
            degradedUrls?: string[];
          };
        }
      | null;
    if (!body?.success) return;
    const converted: Record<string, ProxyTrafficStatUI> = {};
    for (const [url, s] of Object.entries(body.data?.stats ?? {})) {
      converted[url] = {
        total: s.total,
        ok: s.ok,
        err429: s.err429,
        errOther: s.err401 + s.err403 + s.err5xx + s.other,
        availability: s.availability,
      };
    }
    setTrafficStats(converted);
    setDegradedUrls((body.data?.degradedUrls as string[] | undefined) ?? []);
    setProxyDisabled(body.data?.proxyDisabled ?? null);
    setStatsMeta({
      hours: body.data?.hours ?? 24,
      poolUpdatedAt: body.data?.poolUpdatedAt ?? null,
      lastHealthAt: body.data?.lastHealthAt ?? null,
    });
  };

  /** 手动刷新统计（带 loading 指示与成功提示） */
  const refreshStats = async (): Promise<void> => {
    setStatsLoading(true);
    try {
      const res = await fetch("/api/admin/upstream-proxy/stats?hours=24");
      applyStats(await res.json());
      message.success(t("upstreamProxyStatsUpdated"));
    } catch {
      // 静默：统计失败不影响页面主体
    } finally {
      setStatsLoading(false);
    }
  };

  // 挂载后加载一次统计（仅 Docker；stats API 在非 Docker 部署返回 400）
  useEffect(() => {
    if (!isDocker) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/upstream-proxy/stats?hours=24");
        const data: unknown = await res.json();
        if (!cancelled) applyStats(data);
      } catch {
        // 静默：统计失败不影响页面主体
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDocker]);

  const healthMap = parseHealthMap(config?.[HEALTH_KEY]);
  const poolMap = parsePoolMap(config?.[POOL_KEY]);
  const parsed = parseProxyConfig(config?.[CONFIG_KEY]);
  const currentGroup = isNew ? undefined : parsed.groups.find((g) => g.name === id);

  // 路由 id / 服务器配置值变化时回填表单（渲染期 prev 值比较；值未变时不覆盖未保存的编辑）
  const [prevKey, setPrevKey] = useState<string>("");
  const syncKey = `${id ?? ""}|${config?.[CONFIG_KEY] ?? ""}`;
  if (config && prevKey !== syncKey) {
    setPrevKey(syncKey);
    const g = isNew ? undefined : parsed.groups.find((x) => x.name === id);
    if (g) {
      setFormGroup({
        id: genId(),
        name: g.name,
        sourceUrl: g.sourceUrl,
        urlsText: g.urls.join("\n"),
        boundPlatformIds: Object.entries(parsed.platformGroup)
          .filter(([, groupName]) => groupName === g.name)
          .map(([pid]) => pid),
        enabled: g.enabled,
        autoRefresh: g.autoRefresh,
        refreshIntervalMin: g.refreshIntervalMin ?? null,
      });
    } else if (isNew) {
      setFormGroup({ id: genId(), name: "", sourceUrl: "", urlsText: "", boundPlatformIds: [], enabled: true, autoRefresh: true, refreshIntervalMin: null });
    }
  }

  /** 某份已解析配置 → 全组表单态（组顺序保持配置原序；保存/删除时与当前组合并） */
  const groupsFormFrom = (src: ParsedConfig): GroupFormState[] =>
    src.groups.map((g) => ({
      id: genId(),
      name: g.name,
      sourceUrl: g.sourceUrl,
      urlsText: g.urls.join("\n"),
      boundPlatformIds: Object.entries(src.platformGroup)
        .filter(([, groupName]) => groupName === g.name)
        .map(([pid]) => pid),
      enabled: g.enabled,
      autoRefresh: g.autoRefresh,
      refreshIntervalMin: g.refreshIntervalMin ?? null,
    }));

  /** 保存前强制重新验证并解析最新配置：多实例/多标签页下 SWR 缓存可能落后于
   *  其他页面刚做的修改（禁用/删除组），直接基于旧缓存构造整份配置会把
   *  旧状态写回覆盖（如已禁用的组复活）；mutate 失败时退回当前缓存 */
  const latestConfig = async (): Promise<{ raw: string | undefined; src: ParsedConfig }> => {
    const latest = await mutate();
    const raw = latest?.[CONFIG_KEY] ?? config?.[CONFIG_KEY];
    return { raw, src: parseProxyConfig(raw) };
  };

  const saveConfig = async (groupsForm: GroupFormState[], src: ParsedConfig, successKey: string) => {
    const result = buildConfigJson(
      groupsForm,
      src.platformIds,
      src.healthCheckUrl ?? "",
      src.healthCheckIntervalMin ?? null
    );
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
    // 保存前强制重新验证（见 latestConfig）：多实例/多标签页下旧缓存构造
    // 会把其他页面刚做的禁用/删除等修改写回覆盖
    const { src } = await latestConfig();
    // 新建组追加到末尾；编辑组在原位置替换（其余组以最新已保存配置为基准）
    const merged = isNew
      ? [...groupsFormFrom(src), formGroup]
      : groupsFormFrom(src).map((g) => (g.name === id ? formGroup : g));
    const ok = await saveConfig(merged, src, "upstreamProxyGroupSaved");
    if (ok && name) {
      router.replace(`/admin/upstream-proxy/${encodeURIComponent(name)}`);
      // 保存后立即拉取订阅源并验证代理连通性（仅 Docker，整体禁用时跳过——
      // 本设备经环境变量关闭代理，自动验证无意义），
      // 不等 cron 周期；失败不阻断保存成功的提示
      if (isDocker && proxyDisabled !== "all") {
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
    // 自动验证静默（manual=false）：无候选时不弹 warning，不打断保存成功提示
    if (hasCandidate) await checkProxyHealthNow(true, false);
  };

  /** 手动触发拉取/检查前确认表单与已保存配置一致，避免结果与页面显示对不上。
   *  比较构造与 handleSave 相同（编辑中的组替换到对应位置），且基准用最新
   *  已保存配置（见 latestParsed），否则 allGroupsForm 全派生自已保存配置、
   *  恒等比较恒真、守卫失效——旧缓存下还会误判「一致」放行 */
  const ensureSaved = async (): Promise<boolean> => {
    const { raw, src } = await latestConfig();
    const saved = raw;
    const merged = isNew
      ? [...groupsFormFrom(src), formGroup]
      : groupsFormFrom(src).map((g) => (g.name === id ? formGroup : g));
    const result = buildConfigJson(
      merged,
      src.platformIds,
      src.healthCheckUrl ?? "",
      src.healthCheckIntervalMin ?? null
    );
    if (!result.ok || result.value !== saved) {
      message.warning(t("upstreamProxySaveFirst"));
      return false;
    }
    return true;
  };

  /** 立即拉取订阅源（手动按钮与「保存后自动拉取」共用）；
   *  拉取针对全部配置了订阅地址的组，成功后刷新配置与健康数据 */
  const pullProxyGroupsNow = async (skipEnsure = false) => {
    if (!skipEnsure && !(await ensureSaved())) return;
    setPulling(true);
    try {
      const res = await fetch("/api/admin/upstream-proxy/pull", { method: "POST" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        mutate();
        const results = (data.data?.results ?? {}) as Record<string, { error?: string }>;
        if (Object.keys(results).length === 0) {
          // 全部组禁用或无订阅地址：拉取无可执行目标，此前误报「拉取完成」假成功
          message.warning(t("upstreamProxyNoActivePullGroups"));
        } else {
          const failed = Object.values(results).filter((r) => r?.error);
          if (failed.length === Object.keys(results).length) {
            message.error(t("upstreamProxyPullFailed"));
          } else if (failed.length > 0) {
            message.warning(t("upstreamProxyPullPartial"));
          } else {
            message.success(t("upstreamProxyPulled"));
          }
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
   *  GET 渐进刷新「检查中 X/Y」（每批写库后 mutate 同步健康数据）。
   *  manual=true（按钮发起）时无候选（total=0）如实 warning；自动验证（保存后
   *  触发）保持静默，不打断保存成功提示 */
  const checkProxyHealthNow = async (skipEnsure = false, manual = true) => {
    if (!skipEnsure && !(await ensureSaved())) return;
    setChecking(true);
    try {
      const res = await fetch("/api/admin/upstream-proxy/health", { method: "POST" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        void startPolling(manual);
      } else {
        message.error(errMsg(data, t("common:error")));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setChecking(false);
    }
  };

  /** 轮询健康检查进度（与列表页 pollHealthProgress 同逻辑）：
   *  running=true 继续轮询并显示「检查中 X/Y」；running=false 且 total>0 完成；
   *  total=0 无候选（全部组禁用/组内无代理）——手动发起时如实提示，此前零反馈；
   *  progress 元组 60s 无变化（后端任务停滞/丢失）时停止轮询并清指示器，防死循环。
   *  所有终止路径复位 pollChainActive，使后续启动入口可再开新链 */
  const pollHealthProgress = async (lastKey = "", stalled = 0, manual = false): Promise<void> => {
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
        checkPollTimer.current = setTimeout(() => void pollHealthProgress(lastKey, stalled + 1, manual), 2000);
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
        checkPollTimer.current = setTimeout(() => void pollHealthProgress(key, nextStalled, manual), 2000);
        return;
      }
      // running=false：total>0 = 检查完成；total=0 = 无候选（全部组禁用/组内
      // 无代理）——手动发起时如实提示，此前零反馈
      setCheckProgress(null);
      pollChainActive.current = false;
      if (progress.total > 0) {
        message.success(t("upstreamProxyHealthDone"));
      } else if (manual) message.warning(t("upstreamProxyNoHealthCandidates"));
    } catch {
      // 轮询失败按停滞累计（检查仍在后台继续，多等一轮）
      if (stalled + 1 >= 30) {
        setCheckProgress(null);
        pollChainActive.current = false;
        return;
      }
      checkPollTimer.current = setTimeout(() => void pollHealthProgress(lastKey, stalled + 1, manual), 2000);
    }
  };

  /** 轮询链单飞入口：挂载同步/手动检查/保存后自动验证统一走此启动，已有活动链时
   *  不再重复启动（检查期间 config 每批变化会重跑挂载 effect，无此守卫将叠加多条并行链）。
   *  manual=true 表示由「立即检查」按钮发起，无候选时如实提示（挂载同步/自动验证静默） */
  const startPolling = (manual = false): void => {
    if (pollChainActive.current) return;
    pollChainActive.current = true;
    void pollHealthProgress("", 0, manual);
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

  const handleDelete = async () => {
    if (isNew) return;
    setDeleting(true);
    try {
      // 删除前也以最新已保存配置为基准（同 handleSave：旧缓存下会把其他
      // 页面刚做的禁用/删除修改写回覆盖）
      const { src } = await latestConfig();
      const ok = await saveConfig(
        groupsFormFrom(src).filter((g) => g.name !== id),
        src,
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

  /** 组级请求统计聚合（组内各代理分类计数求和；无请求数据时 availability 为 undefined）。
   *  trafficStats 键为落库的归一化统计键（requestLogs.proxyUrl 写入前归一化为
   *  去凭据 host:port），同 host:port 不同凭据共享同一统计键只计一次（防组级聚合翻倍） */
  const groupTraffic: {
    total: number;
    ok: number;
    err429: number;
    errOther: number;
    availability: number | undefined;
  } = {
    total: sumMaskedStats(groupUrls, trafficStats, (s) => s?.total ?? 0),
    ok: sumMaskedStats(groupUrls, trafficStats, (s) => s?.ok ?? 0),
    err429: sumMaskedStats(groupUrls, trafficStats, (s) => s?.err429 ?? 0),
    errOther: sumMaskedStats(groupUrls, trafficStats, (s) => s?.errOther ?? 0),
    availability: undefined,
  };
  if (groupTraffic.total > 0) groupTraffic.availability = groupTraffic.ok / groupTraffic.total;

  const summary: ProxyGroupSummary = {
    name: formGroup.name || currentGroup?.name || (isNew ? "" : id ?? ""),
    sourceUrl: formGroup.sourceUrl || currentGroup?.sourceUrl || "",
    proxyCount: groupUrls.length,
    okCount: groupUrls.filter((u) => healthMap[u]?.status === "ok").length,
    failCount: groupUrls.filter((u) => healthMap[u]?.status === "fail").length,
    enabled: formGroup.enabled,
    availability: groupTraffic.availability,
  };

  /** 组列表行数据（侧栏与返回条摘要共用） */
  const summaries: ProxyGroupSummary[] = parsed.groups.map((g) => {
    const urls = collectGroupUrls(poolMap[g.name] ?? [], g.urls);
    const gTotal = sumMaskedStats(urls, trafficStats, (s) => s?.total ?? 0);
    const gOk = sumMaskedStats(urls, trafficStats, (s) => s?.ok ?? 0);
    return {
      name: g.name,
      sourceUrl: g.sourceUrl,
      proxyCount: urls.length,
      okCount: urls.filter((u) => healthMap[u]?.status === "ok").length,
      failCount: urls.filter((u) => healthMap[u]?.status === "fail").length,
      enabled: g.enabled,
      availability: gTotal > 0 ? gOk / gTotal : undefined,
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

  /** 统计小格（组级统计条）：标签 + 数值 */
  const statCell = (label: string, value: string, valueClass = "text-zinc-900 dark:text-zinc-100") => (
    <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/50 px-3 py-2">
      <p className="text-[10px] text-zinc-400 truncate">{label}</p>
      <p className={`text-sm font-bold font-mono mt-0.5 ${valueClass}`}>{value}</p>
    </div>
  );

  /** 代理列表与可用性监控区块 — 更新状态（最近拉取/检查）+ 组级统计 +
   *  每代理健康与真实请求统计（请求数 / 200 / 429 / 其他错误 / 可用率） */
  const proxyListView = (
    <div className="rounded-2xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{t("upstreamProxyMonitoring")}</h3>
        {isDocker && (
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {checkProgress && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400 shrink-0">
                {t("upstreamProxyHealthChecking", checkProgress)}
              </span>
            )}
            <Button
              variant="default"
              size="sm"
              onClick={() => void refreshStats()}
              loading={statsLoading}
              icon={<RefreshCw size={14} />}
            >
              {t("upstreamProxyRefreshStats")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => void pullProxyGroupsNow()}
              loading={pulling}
              icon={<RefreshCw size={14} />}
              disabled={!currentGroup?.sourceUrl || proxyDisabled === "all"}
            >
              {t("upstreamProxyPullNow")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => void checkProxyHealthNow()}
              loading={checking}
              icon={<RefreshCw size={14} />}
              disabled={groupUrls.length === 0 || proxyDisabled === "all"}
            >
              {t("upstreamProxyCheckNow")}
            </Button>
          </div>
        )}
      </div>
      <div className="p-4 flex flex-col gap-4">
        {isDocker && (
          <>
            {/* 定期更新状态：最近拉取/最近检查（只读展示，不提供配置） + 统计窗口 */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-400">
              <span>
                {t("upstreamProxyLastPull")}：
                {statsMeta.poolUpdatedAt ? formatChecked(statsMeta.poolUpdatedAt) : "—"}
              </span>
              <span>
                {t("upstreamProxyLastCheck")}：
                {statsMeta.lastHealthAt ? formatChecked(statsMeta.lastHealthAt) : "—"}
              </span>
              <span>{t("upstreamProxyStatsPeriod", { hours: statsMeta.hours })}</span>
            </div>
            <p className="text-[11px] text-zinc-400 -mt-2">{t("upstreamProxyCronHint")}</p>
            {/* 组级统计：可用率 + 请求数 + 200 + 429 + 其他错误 */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {statCell(
                t("upstreamProxyAvailability"),
                groupTraffic.availability === undefined
                  ? "—"
                  : `${Math.round(groupTraffic.availability * 100)}%`,
                groupTraffic.availability === undefined
                  ? "text-zinc-400"
                  : groupTraffic.availability >= 0.9
                    ? "text-emerald-600 dark:text-emerald-400"
                    : groupTraffic.availability >= 0.5
                      ? "text-amber-600 dark:text-amber-500"
                      : "text-rose-500"
              )}
              {statCell(t("upstreamProxyRequests"), String(groupTraffic.total))}
              {statCell(t("upstreamProxySuccess"), String(groupTraffic.ok), "text-emerald-600 dark:text-emerald-400")}
              {statCell("429", String(groupTraffic.err429), "text-amber-600 dark:text-amber-500")}
              {statCell(t("upstreamProxyErrOther"), String(groupTraffic.errOther), "text-rose-500")}
            </div>
          </>
        )}
        {groupUrls.length === 0 ? (
          <p className="text-xs text-zinc-400">{t("upstreamProxyGroupEmpty")}</p>
        ) : (
          <ul className="space-y-1.5">
            {groupUrls.map((url) => {
              const entry = healthMap[url];
              const status = entry?.status ?? "none";
              const stat = trafficStats?.[proxyStatKey(url)];
              // 统计降权：健康点仍显示 ok 但路由已跳过（窗口内错误率过高，
              // 窗口滑动自动恢复）——此前完全不可见；按代理级键匹配，
              // 同 host:port 不同账号的降权状态互不误伤
              const degraded = degradedUrls.includes(proxyStatKey(url));
              return (
                <li key={url} className="flex items-start gap-2 text-xs">
                  <span
                    className={`mt-1 inline-block h-2 w-2 rounded-full shrink-0 ${
                      status === "ok"
                        ? "bg-emerald-500"
                        : status === "fail"
                          ? "bg-rose-500"
                          : "bg-zinc-300 dark:bg-zinc-600"
                    }`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-zinc-700 dark:text-zinc-300 truncate min-w-0 flex-1">
                        {displayProxyUrl(url)}
                      </span>
                      {degraded && (
                        <span
                          className="shrink-0 text-[10px] px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400"
                          title={t("upstreamProxyDegradedTip")}
                        >
                          {t("upstreamProxyDegraded")}
                        </span>
                      )}
                      <span className="shrink-0 text-zinc-400 text-right">
                        {renderHealthText(status, entry, t)}
                      </span>
                    </div>
                    {isDocker && (
                      <div className="flex items-center gap-2.5 mt-0.5 text-[10px] text-zinc-400">
                        {stat ? (
                          <>
                            <span>
                              {t("upstreamProxyRequests")} {stat.total}
                            </span>
                            <span className="text-emerald-600 dark:text-emerald-400">
                              {t("upstreamProxySuccess")} {stat.ok}
                            </span>
                            <span className="text-amber-600 dark:text-amber-500">429 {stat.err429}</span>
                            <span className="text-rose-500">
                              {t("upstreamProxyErrOther")} {stat.errOther}
                            </span>
                            <span className="text-zinc-500">
                              {t("upstreamProxyAvailability")} {Math.round(stat.availability * 100)}%
                            </span>
                          </>
                        ) : (
                          <span>{t("upstreamProxyNoTrafficStats")}</span>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );

  /** 代理组设置区块（基本信息 / 手动代理 / 绑定平台 + 保存；删除入口在区块标题栏） */
  const editForm = (
    <div className="flex flex-col gap-4">
      {/* 设备级禁用提示（环境变量 UPSTREAM_PROXY_DISABLED 仅影响当前部署实例） */}
      {proxyDisabled && (
        <Alert
          type={proxyDisabled === "all" ? "error" : "warning"}
          showIcon
          message={t(
            proxyDisabled === "all" ? "upstreamProxyDisabledAll" : "upstreamProxyDisabledHealth"
          )}
        />
      )}
      <div className="rounded-2xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{t("upstreamProxyGroupSettings")}</h3>
          {!isNew && (
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
          )}
        </div>
        <div className="p-4 flex flex-col gap-4">
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
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {t("upstreamProxyAutoRefreshLabel")}
                  </label>
                  <p className="text-xs text-zinc-400 mt-0.5">{t("upstreamProxyAutoRefreshHelp")}</p>
                </div>
                <Switch
                  checked={formGroup.autoRefresh}
                  onChange={(checked) => setFormGroup({ ...formGroup, autoRefresh: checked })}
                />
              </div>
              {formGroup.autoRefresh && (
                <div>
                  <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                    {t("upstreamProxyRefreshIntervalLabel")}
                  </label>
                  <InputNumber
                    value={formGroup.refreshIntervalMin}
                    onChange={(v) => setFormGroup({ ...formGroup, refreshIntervalMin: v ?? null })}
                    min={PROXY_PULL_INTERVAL_RANGE.min}
                    max={PROXY_PULL_INTERVAL_RANGE.max}
                    precision={0}
                    placeholder={`${DEFAULT_PULL_INTERVAL_MIN} (${t("upstreamProxyHealthIntervalDefault")})`}
                    className="w-full"
                  />
                  <p className="text-xs text-zinc-400 mt-1">{t("upstreamProxyRefreshIntervalHelp")}</p>
                </div>
              )}
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

          <Button variant="primary" size="sm" onClick={handleSave} loading={submitting} icon={<Save size={14} />}>
            {t("common:save")}
          </Button>
        </div>
      </div>

      {proxyListView}
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