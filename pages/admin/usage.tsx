import { useState, useEffect, useCallback, useMemo } from "react";
import { Select, Tabs, message } from "antd";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  RefreshCw,
  BarChart3,
  AlertTriangle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";
import dynamic from "next/dynamic";
import KeyUsageTab from "@/components/usage/KeyUsageTab";
import PlatformUsageTab from "@/components/usage/PlatformUsageTab";
import AdminLayout from "@/components/AdminLayout";

const UsageChart = dynamic(() => import("@/components/usage/UsageChart"), {
  ssr: false,
  loading: () => (
    <div className="h-[220px] sm:h-[320px] bg-zinc-50 dark:bg-zinc-800/50 rounded-xl animate-pulse" />
  ),
});

// ==================== 类型定义 ====================

interface TrendPoint {
  date: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
}

// ==================== 页面组件 ====================

export default function UsagePage() {
  const { t } = useTranslation("usage");
  const [trendData, setTrendData] = useState<TrendPoint[]>([]);
  const [trendLoading, setTrendLoading] = useState(true);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [period, setPeriod] = useState<string>("month");
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState<string>("key");

  // 获取趋势数据
  useEffect(() => {
    const controller = new AbortController();

    const fetchTrend = async () => {
      setTrendLoading(true);
      setTrendError(null);
      try {
        const params = new URLSearchParams({ period });
        const res = await fetch(`/api/admin/usage/trend?${params}`, {
          signal: controller.signal,
        });
        const data = await res.json() as Record<string, any>;
        if (!res.ok || !data.success) {
          const errMsg = data.error || t("httpError", { status: res.status });
          console.error("[usage trend] load failed:", errMsg, data);
          setTrendError(errMsg);
          return;
        }
        if (Array.isArray(data.data)) {
          setTrendData(data.data);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[usage trend] request error:", errMsg, err);
        setTrendError(errMsg);
        message.error(t("dashboard:fetchFailed"));
      } finally {
        if (!controller.signal.aborted) setTrendLoading(false);
      }
    };

    fetchTrend();
    return () => controller.abort();
  }, [period, t, refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // 汇总趋势数据（给图表上方的总览用）
  const trendSummary = useMemo(() => {
    const totalRequests = trendData.reduce((s, d) => s + d.requests, 0);
    const totalTokens = trendData.reduce((s, d) => s + d.tokens, 0);
    return { totalRequests, totalTokens };
  }, [trendData]);

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
            <div className="h-[220px] sm:h-[320px] flex items-center justify-center">
              <GlobalLoading size="small" />
            </div>
          ) : trendError ? (
            <div className="h-[220px] sm:h-[320px] flex flex-col items-center justify-center gap-2">
              <AlertTriangle className="text-2xl text-red-400" />
              <p className="text-sm text-red-500 font-medium">
                {t("dashboard:fetchFailed")}
              </p>
              <p className="text-xs text-zinc-400 max-w-md text-center">
                {trendError}
              </p>
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={14} />}
                onClick={handleRefresh}
                className="mt-1"
              >
                {t("common:retry")}
              </Button>
            </div>
          ) : trendData.length === 0 ? (
            <div className="h-[220px] sm:h-[320px] flex flex-col items-center justify-center gap-2">
              <BarChart3 className="text-3xl text-zinc-300" />
              <p className="text-sm text-zinc-400">
                {t("common:noData")}
              </p>
              <p className="text-xs text-zinc-300">
                {t("trendEmptyHint")}
              </p>
            </div>
          ) : (
            <UsageChart
              data={trendData}
              granularity={period === "today" ? "hourly" : "daily"}
            />
          )}
          {trendData.length > 0 && (
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
            </div>
          )}
        </div>

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
