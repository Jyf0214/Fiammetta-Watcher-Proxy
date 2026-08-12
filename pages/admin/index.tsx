import { useState, useLayoutEffect, useCallback, useMemo } from "react";
import { message } from "antd";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import {
  Cloud,
  Key,
  Globe,
  Database,
  LayoutDashboard,
  RefreshCw,
  Pause,
  Play,
  Clock,
  Grid,
  List,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDuration, formatCompactNumber, valueFontSize } from "@/lib/format";
import { useApi } from "@/hooks/use-api";
import GlobalLoading from "@/components/Loading";
import dynamic from "next/dynamic";
import AdminLayout from "@/components/AdminLayout";

// 懒加载迷你趋势图组件（与用量页共享同一图表模块，复用同一份 recharts chunk）
const MiniTrendChart = dynamic(
  () => import("@/components/usage/charts").then((m) => m.MiniTrendChart),
  {
    ssr: false,
    loading: () => <div className="w-20 h-8 bg-zinc-100 dark:bg-zinc-800 rounded animate-pulse" />,
  }
);

// ==================== 类型定义 ====================

interface Stats {
  activePlatforms: number;
  totalKeys: number;
  activeKeys: number;
  totalRequests: number;
  totalTokens: number;
  avgTtft: number;
  avgDuration: number;
}

interface TrendPoint {
  date: string;
  value: number;
}

/** /api/admin/usage/trend 原始响应点（与迷你图表 TrendPoint 结构不同） */
interface TrendApiPoint {
  date: string;
  requests: number;
  tokens: number;
}

/** 视图模式 */
type ViewMode = "grid" | "detail";

// ==================== 常量 ====================

const AUTO_REFRESH_INTERVAL = 30_000; // 30 秒自动刷新

// ==================== 页面组件 ====================

function DashboardContent() {
  const { t } = useTranslation("dashboard");
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  // 统计卡片数据：30s 自动轮询由 SWR refreshInterval 驱动（关闭自动刷新时停轮询）
  const { data: stats, isLoading, mutate: mutateStats } = useApi<Stats>("/api/admin/stats", {
    refreshInterval: autoRefresh ? AUTO_REFRESH_INTERVAL : 0,
  });

  // 趋势数据（详细视图迷你图表）：仅在 detail 视图下请求（key 为 null 时不发请求），
  // 切换视图时直接取缓存；数据转换逻辑与原 fetchTrendData 一致
  const trendKey = viewMode === "detail" ? "/api/admin/usage/trend?period=today" : null;
  const { data: trendRaw, mutate: mutateTrend } = useApi<TrendApiPoint[]>(trendKey);

  const trendData = useMemo<Record<string, TrendPoint[]>>(() => {
    if (!trendRaw) return {};
    const trends: Record<string, TrendPoint[]> = {
      requests: [],
      tokens: [],
      avgTtft: [],
      avgDuration: [],
    };
    for (const point of trendRaw) {
      const reqs = point.requests || 0;
      const toks = point.tokens || 0;

      // 请求数和 Token 用量：使用 API 原始聚合值
      trends.requests.push({ date: point.date, value: reqs });
      trends.tokens.push({ date: point.date, value: toks });

      // 平均 TTFT / 耗时：API 未返回逐时段数据，不伪造
      // 保持空数组，图表组件会优雅降级
    }
    return trends;
  }, [trendRaw]);

  // 数据更新成功后记录最后刷新时间
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useLayoutEffect(() => {
    if (stats) setLastRefreshed(new Date());
  }, [stats]);

  // 手动刷新：统计 + （详细视图下）趋势重新验证
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    const jobs: Promise<unknown>[] = [
      // 统计失败提示（与原手动刷新行为一致）；趋势失败静默
      mutateStats().catch(() => {
        message.error(t("common:error"));
      }),
    ];
    if (viewMode === "detail") {
      jobs.push(mutateTrend().catch(() => {}));
    }
    Promise.all(jobs).finally(() => setRefreshing(false));
  }, [viewMode, mutateStats, mutateTrend, t]);

  // 切换自动刷新
  const toggleAutoRefresh = useCallback(() => {
    setAutoRefresh((prev) => !prev);
  }, []);

  // 切换视图模式
  const toggleViewMode = useCallback(() => {
    setViewMode((prev) => (prev === "grid" ? "detail" : "grid"));
  }, []);

  // ==================== 统计卡片 ====================

  const statCards = [
    {
      key: "platforms",
      title: t("activePlatforms"),
      value: stats?.activePlatforms ?? 0,
      icon: <Cloud />,
      color: "bg-blue-50",
      iconColor: "text-blue-500",
    },
    {
      key: "keys",
      title: t("activeKeys"),
      value: stats?.activeKeys ?? 0,
      icon: <Key />,
      color: "bg-emerald-50",
      iconColor: "text-emerald-500",
    },
    {
      key: "requests",
      title: t("totalRequests"),
      value: stats?.totalRequests ?? 0,
      icon: <Globe />,
      color: "bg-purple-50",
      iconColor: "text-purple-500",
    },
    {
      key: "tokens",
      title: t("totalTokens"),
      value: stats?.totalTokens ?? 0,
      icon: <Database />,
      color: "bg-amber-50",
      iconColor: "text-amber-500",
    },
    {
      key: "avgTtft",
      title: t("avgTtft"),
      value: stats?.avgTtft ?? 0,
      icon: <Clock />,
      color: "bg-orange-50",
      iconColor: "text-orange-500",
      get display() { return formatDuration(this.value, t); },
    },
    {
      key: "avgDuration",
      title: t("avgDuration"),
      value: stats?.avgDuration ?? 0,
      icon: <Clock />,
      color: "bg-cyan-50",
      iconColor: "text-cyan-500",
      get display() { return formatDuration(this.value, t); },
    },
  ];

  // 获取图表颜色（与卡片配色统一）
  const getChartColor = (key: string): string => {
    const colorMap: Record<string, string> = {
      platforms: "#3b82f6",
      keys: "#10b981",
      requests: "#8b5cf6",
      tokens: "#f59e0b",
      avgTtft: "#f97316",
      avgDuration: "#06b6d4",
    };
    return colorMap[key] || "#6b7280";
  };

  // ==================== 渲染 ====================

  if (isLoading && !stats) {
    return <GlobalLoading size="large" />;
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<LayoutDashboard size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title={t("title")}
        description={
          <div className="flex flex-col">
            <span>{t("desc")}</span>
            {lastRefreshed && (
              <span className="text-xs text-zinc-400 mt-0.5">
                {t("lastRefresh")}: {lastRefreshed.toLocaleTimeString()}
              </span>
            )}
          </div>
        }
        extra={
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              className="max-sm:!w-9 max-sm:!h-9"
              icon={viewMode === "grid" ? <List size={14} /> : <Grid size={14} />}
              onClick={toggleViewMode}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              className="max-sm:!w-9 max-sm:!h-9 text-zinc-500"
              icon={autoRefresh ? <Pause size={14} /> : <Play size={14} />}
              onClick={toggleAutoRefresh}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              className="max-sm:!w-9 max-sm:!h-9"
              icon={<RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />}
              onClick={handleRefresh}
              disabled={refreshing}
            />
          </div>
        }
      />

      {/* 统计卡片 */}
      {viewMode === "grid" ? (
        // 网格视图：一行多个
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
          {statCards.map((card) => {
            const display = "display" in card && card.display ? card.display : null;
            const displayVal = display ? display.value : formatCompactNumber(card.value, t);
            return (
              <ProCard key={card.key} className="bg-white border-zinc-200" padding="p-3">
                <div className="flex items-center gap-2.5">
                  <div className={`h-8 w-8 ${card.color} rounded-lg flex items-center justify-center shrink-0`}>
                    <span className={`${card.iconColor} text-sm`}>{card.icon}</span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-zinc-500 text-[11px] leading-tight truncate mb-0.5">{card.title}</p>
                    <p className={`${valueFontSize(displayVal)} font-bold text-zinc-900 leading-tight tabular-nums whitespace-nowrap`}>
                      {displayVal}
                      {display?.suffix && (
                        <span className="text-sm font-normal text-zinc-400 ml-1">{display.suffix}</span>
                      )}
                    </p>
                  </div>
                </div>
              </ProCard>
            );
          })}
        </div>
      ) : (
        // 详细视图：一行一个，带趋势图
        <div className="space-y-3 mb-6">
          {statCards.map((card) => {
            const display = "display" in card && card.display ? card.display : null;
            const displayVal = display ? display.value : formatCompactNumber(card.value, t);
            const hasTrend = trendData[card.key] && trendData[card.key].length > 0;
            return (
              <ProCard key={card.key} className="bg-white border-zinc-200" padding="px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className={`h-8 w-8 ${card.color} rounded-lg flex items-center justify-center shrink-0`}>
                    <span className={`${card.iconColor} text-sm`}>{card.icon}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-zinc-500 text-[11px] leading-tight mb-0.5">{card.title}</p>
                    <p className={`${valueFontSize(displayVal)} font-bold text-zinc-900 tabular-nums leading-tight whitespace-nowrap`}>
                      {displayVal}
                      {display?.suffix && (
                        <span className="text-sm font-normal text-zinc-400 ml-1">{display.suffix}</span>
                      )}
                    </p>
                  </div>
                  {hasTrend && (
                    <div className="w-20 h-9 shrink-0">
                      <MiniTrendChart
                        data={trendData[card.key]}
                        color={getChartColor(card.key)}
                      />
                    </div>
                  )}
                </div>
              </ProCard>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}

// ==================== 带 AdminLayout 包装的页面 ====================

export default function AdminDashboard() {
  return (
    <AdminLayout>
      <DashboardContent />
    </AdminLayout>
  );
}
