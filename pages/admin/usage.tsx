import { useState, useEffect, useCallback, useMemo } from "react";
import { Select, Tabs, message } from "antd";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
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
    <div className="h-[320px] bg-zinc-50 dark:bg-zinc-800/50 rounded-xl animate-pulse" />
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
  const { t } = useTranslation();
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
        const data = await res.json();
        if (!res.ok || !data.success) {
          const errMsg = data.error || `HTTP ${res.status}`;
          console.error("[用量趋势] 加载失败:", errMsg, data);
          setTrendError(errMsg);
          return;
        }
        if (Array.isArray(data.data)) {
          setTrendData(data.data);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[用量趋势] 请求异常:", errMsg, err);
        setTrendError(errMsg);
        message.error(t("dashboard.fetch_failed"));
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
      label: t("usage.tab_key") || "Key 用量",
      children: <KeyUsageTab period={period} refreshKey={refreshKey} />,
    },
    {
      key: "platform",
      label: t("usage.tab_platform") || "平台用量",
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
          title={t("admin.usage")}
          description={t("admin.usage_desc")}
          extra={
            <div className="flex gap-2">
              <Select
                value={period}
                onChange={setPeriod}
                className="w-32"
                options={[
                  { value: "all", label: t("usage.period_all") },
                  { value: "today", label: t("usage.period_today") },
                  { value: "week", label: t("usage.period_week") },
                  { value: "month", label: t("usage.period_month") },
                ]}
              />
              <Button
                variant="default"
                icon={<RefreshCw />}
                onClick={handleRefresh}
                disabled={trendLoading}
              >
                {t("common.refresh")}
              </Button>
            </div>
          }
        />

        {/* 趋势折线图 — 全局共享 */}
        <ProCard
          title={
            <span className="font-semibold text-zinc-900">
              {t("usage.trend_title")}
            </span>
          }
          className="mb-4"
        >
          {trendLoading ? (
            <div className="h-[320px] flex items-center justify-center">
              <GlobalLoading size="small" />
            </div>
          ) : trendError ? (
            <div className="h-[320px] flex flex-col items-center justify-center gap-2">
              <AlertTriangle className="text-2xl text-red-400" />
              <p className="text-sm text-red-500 font-medium">
                {t("dashboard.fetch_failed")}
              </p>
              <p className="text-xs text-zinc-400 max-w-md text-center">
                {trendError}
              </p>
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw />}
                onClick={handleRefresh}
                className="mt-1"
              >
                {t("common.retry") || "重试"}
              </Button>
            </div>
          ) : trendData.length === 0 ? (
            <div className="h-[320px] flex flex-col items-center justify-center gap-2">
              <BarChart3 className="text-3xl text-zinc-300" />
              <p className="text-sm text-zinc-400">
                {t("common.no_data")}
              </p>
              <p className="text-xs text-zinc-300">
                {t("usage.trend_empty_hint") || "发送 API 请求后数据将在此显示"}
              </p>
            </div>
          ) : (
            <UsageChart
              data={trendData}
              granularity={period === "today" ? "hourly" : "daily"}
            />
          )}
          {trendData.length > 0 && (
            <div className="flex items-center justify-center gap-8 pt-3 border-t border-zinc-50">
              <div className="text-center">
                <p className="text-xs text-zinc-400">
                  {t("usage.requests")}
                </p>
                <p className="text-sm font-semibold text-zinc-700">
                  {trendSummary.totalRequests.toLocaleString()}
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs text-zinc-400">
                  {t("usage.total_tokens")}
                </p>
                <p className="text-sm font-semibold text-zinc-700">
                  {trendSummary.totalTokens.toLocaleString()}
                </p>
              </div>
            </div>
          )}
        </ProCard>

        {/* Tab 切换：Key 用量 / 平台用量 */}
        <ProCard padding="p-0">
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            className="px-5 pt-2"
            items={tabItems}
          />
        </ProCard>
      </PageContainer>
    </AdminLayout>
  );
}
