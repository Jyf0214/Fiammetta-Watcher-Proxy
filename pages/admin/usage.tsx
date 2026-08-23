import { useState, useEffect, useCallback, useMemo } from "react";
import { Select, Tabs, message } from "antd";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { AsyncBoundary } from "@/components/ui/AsyncBoundary";
import { BarListChart } from "@/components/usage/BarListChart";
import { HeatmapCard } from "@/components/usage/HeatmapCard";
import { RefreshCw, BarChart3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useApi, useRefreshKey, UNAUTHORIZED_MESSAGE, type ApiResponse } from "@/hooks/use-api";
import useSWR from "swr";
import dynamic from "next/dynamic";
import KeyUsageTab from "@/components/usage/KeyUsageTab";
import PlatformUsageTab from "@/components/usage/PlatformUsageTab";
import AdminLayout from "@/components/AdminLayout";

const UsageChart = dynamic(
  () => import("@/components/usage/charts").then((m) => m.UsageChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[220px] sm:h-[320px] bg-zinc-50 dark:bg-zinc-800/50 rounded-xl animate-pulse" />
    ),
  }
);

// ==================== 类型定义 ====================

interface TrendPoint {
  date: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  tps: number;
}

// ==================== 页面组件 ====================

export default function UsagePage() {
  const { t } = useTranslation("usage");
  const [period, setPeriod] = useState<string>("month");
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState<string>("key");
  // 挂载时固化当日序号：避免渲染期（useMemo 内）调用非纯 Date.now()，
  // 也保证同一次挂载内 streak 的「今天」口径不随重渲染漂移
  const [todaySeq] = useState(() => Math.floor(Date.now() / 86400000));

  // 趋势数据：key 含 period，切换周期时 SWR 自动重新请求
  const {
    data: trendData,
    error: trendError,
    isValidating: trendLoading,
    mutate: mutateTrend,
  } = useApi<TrendPoint[]>(`/api/admin/usage/trend?period=${period}`);

  // 平台用量数据（用于排行榜）
  const {
    data: platformData,
  } = useApi<Array<{ name: string; stats: { totalRequests: number; totalTokens: number } }>>(
    `/api/admin/usage/platform?period=${period}`
  );

  // 峰值耗时（秒）：/api/admin/usage 顶层 peakDuration 字段。
  // apiFetcher 只解包 data，顶层字段需此处直接请求读取；401 处理与 apiFetcher 对齐。
  // key 用数组而非 URL 字符串：KeyUsageTab 以同一 URL 为 key 通过 useApi 读取 data
  // 数组，若此处也以 URL 为 key，SWR 按 key 去重缓存且不区分 fetcher，一方必然
  // 拿到另一方形态的数据（number 上 .reduce 崩溃 / 数组被当峰值显示）
  const { data: peakDuration, mutate: mutatePeakDuration } = useSWR<number | null>(
    ["usage-peak", period],
    async ([, p]: [string, string]) => {
      const res = await fetch(`/api/admin/usage?period=${p}`);
      const body = (await res.json().catch(() => null)) as
        | (ApiResponse<unknown> & { peakDuration?: number | null })
        | null;
      if (res.status === 401) {
        message.warning(t("auth:unauthorized"));
        if (typeof window !== "undefined") {
          window.location.replace("/admin/login");
        }
        throw new Error(UNAUTHORIZED_MESSAGE);
      }
      if (!body || body.success !== true) return null;
      return body.peakDuration ?? null;
    }
  );

  // 刷新按钮（refreshKey 计数）触发趋势、峰值耗时与子 Tab（各自内部监听）重新验证
  useRefreshKey(refreshKey, () => {
    void mutateTrend();
    void mutatePeakDuration();
  });

  // 请求失败提示（401 已由 fetcher 统一提示并跳转登录页）
  useEffect(() => {
    if (trendError && trendError.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("dashboard:fetchFailed"));
    }
  }, [trendError, t]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // 汇总趋势数据（给图表上方的总览用）
  const trendSummary = useMemo(() => {
    const data = trendData ?? [];
    const totalRequests = data.reduce((s, d) => s + d.requests, 0);
    const totalTokens = data.reduce((s, d) => s + d.tokens, 0);
    const avgTps = data.length > 0
      ? Math.round((data.reduce((s, d) => s + (d.tps || 0), 0) / data.length) * 100) / 100
      : 0;
    // 单日/单小时真实峰值（而非汇总求和）
    const peakTokens = data.reduce((m, d) => Math.max(m, d.tokens), 0);

    // 连续活跃统计：按日期（YYYY-MM-DD 前缀）取真实日历日序号判断相邻相差
    // 1 天，避免 Date 解析的时区歧义（daily 为 UTC 午夜、hourly 为本地时间）；
    // y/m/dd 取自字符串分量经 Date.UTC 编码——原 y*372+m*31+dd 近似编码在
    // Feb28→Mar1（差4）及 30 天月边界（差2）误判不连续，导致跨月 streak 错误归零；
    // 先按日去重再算连续——同一自然日多条记录（如 hourly）不得重置 streak
    const daySeq = Array.from(
      new Set(
        data.map((d) => {
          const [y, m, dd] = d.date.slice(0, 10).split("-").map(Number);
          return Math.floor(Date.UTC(y, m - 1, dd) / 86400000);
        })
      )
    ).sort((a, b) => a - b);
    let longestStreak = 0;
    let run = 0;
    let prevDay = NaN;
    for (const day of daySeq) {
      run = day === prevDay + 1 ? run + 1 : 1;
      if (run > longestStreak) longestStreak = run;
      prevDay = day;
    }
    // 当前连续：必须锚定「今天」——最新活跃日为今天（今日已请求）或
    // 昨天（今日尚未请求但连击未断）才从尾部回推，更早则视为中断归零，
    // 否则停用一个多月后仍会沿用历史旧连击
    const latestDay = daySeq[daySeq.length - 1];
    let currentStreak = 0;
    if (latestDay === todaySeq || latestDay === todaySeq - 1) {
      for (let i = daySeq.length - 1; i >= 0; i--) {
        if (i < daySeq.length - 1 && daySeq[i] !== daySeq[i + 1] - 1) break;
        currentStreak += 1;
      }
    }

    return { totalRequests, totalTokens, avgTps, peakTokens, currentStreak, longestStreak };
  }, [trendData, todaySeq]);

  const tabItems = [
    {
      key: "key",
      label: t("tabKey"),
      children: <KeyUsageTab period={period} refreshKey={refreshKey} />,
    },
    {
      key: "platform",
      label: t("tabPlatform"),
      children: (
        <PlatformUsageTab period={period} refreshKey={refreshKey} />
      ),
    },
  ];

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={
            <BarChart3
              size={20}
              className="text-zinc-500 dark:text-zinc-400"
            />
          }
          title={t("admin:usage")}
          description={t("admin:usageDesc")}
          extra={
            <div className="flex gap-2">
              <Select
                value={period}
                onChange={setPeriod}
                className="w-32"
                options={[
                  { value: "all", label: t("periodAll") },
                  { value: "today", label: t("periodToday") },
                  { value: "week", label: t("periodWeek") },
                  { value: "month", label: t("periodMonth") },
                ]}
              />
              <Button
                variant="default"
                icon={<RefreshCw size={14} />}
                onClick={handleRefresh}
                disabled={trendLoading}
              >
                {t("common:refresh")}
              </Button>
            </div>
          }
        />

        {/* 趋势折线图 — 全局共享 */}
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3 px-1">
            {t("trendTitle")}
          </h3>
          {trendLoading ? (
            <div className="h-[220px] sm:h-[320px]">
              <AsyncBoundary isLoading error={null}>
                <></>
              </AsyncBoundary>
            </div>
          ) : trendError ? (
            <div className="h-[220px] sm:h-[320px]">
              <AsyncBoundary isLoading={false} error={trendError} onRetry={handleRefresh}>
                <></>
              </AsyncBoundary>
            </div>
          ) : (trendData ?? []).length === 0 ? (
            <div className="h-[220px] sm:h-[320px]">
              <AsyncBoundary
                isLoading={false}
                error={null}
                isEmpty
                emptyIcon={<BarChart3 className="w-8 h-8" />}
                emptyHint={t("trendEmptyHint")}
              >
                <></>
              </AsyncBoundary>
            </div>
          ) : (
            <UsageChart
              data={trendData ?? []}
              granularity={period === "today" ? "hourly" : "daily"}
            />
          )}
          {(trendData?.length ?? 0) > 0 && (
            <div className="flex items-center justify-center gap-8 pt-3 border-t border-zinc-50 dark:border-zinc-700">
              <div className="text-center">
                <p className="text-xs text-zinc-400">
                  {t("requests")}
                </p>
                <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                  {trendSummary.totalRequests.toLocaleString()}
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs text-zinc-400">
                  {t("totalTokens")}
                </p>
                <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                  {trendSummary.totalTokens.toLocaleString()}
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs text-zinc-400">
                  {t("tps")}
                </p>
                <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                  {trendSummary.avgTps.toFixed(1)}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* 活动热力统计 */}
        <HeatmapCard
          stats={{
            peakTokens: trendSummary?.peakTokens,
            peakDuration: peakDuration ?? undefined,
            currentStreak: trendSummary?.currentStreak,
            longestStreak: trendSummary?.longestStreak,
          }}
          isLoading={trendLoading}
          className="mb-4"
        />

        {/* 排行榜 */}
        {(platformData ?? []).length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <BarListChart
              title={t("topPlatforms")}
              items={(platformData ?? [])
                .filter((item) => item.stats.totalRequests > 0)
                .map((item) => ({ label: item.name, value: item.stats.totalRequests }))
                .slice(0, 5)}
            />
            <BarListChart
              title={t("topTokens")}
              items={(platformData ?? [])
                .filter((item) => item.stats.totalTokens > 0)
                .map((item) => ({ label: item.name, value: item.stats.totalTokens }))
                .slice(0, 5)}
            />
          </div>
        )}

        {/* Tab 切换：Key 用量 / 平台用量 */}
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          className="px-5 pt-2"
          items={tabItems}
        />
      </PageContainer>
    </AdminLayout>
  );
}
