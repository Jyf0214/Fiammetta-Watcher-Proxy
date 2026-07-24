"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { message } from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
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
import GlobalLoading from "@/components/Loading";
import dynamic from "next/dynamic";
import AdminLayout from "@/components/AdminLayout";

// 懒加载迷你趋势图组件
const MiniTrendChart = dynamic(() => import("@/components/MiniTrendChart"), {
  ssr: false,
  loading: () => <div className="w-20 h-8 bg-zinc-100 dark:bg-zinc-800 rounded animate-pulse" />,
});

// ==================== 类型定义 ====================

interface Stats {
  totalPlatforms: number;
  activePlatforms: number;
  totalKeys: number;
  activeKeys: number;
  totalRequests: number;
  errorRequests: number;
  totalTokens: number;
  avgTtft: number;
  avgDuration: number;
  recentEvents: Array<{
    id: string;
    level: string;
    message: string;
    createdAt: string;
  }>;
}

interface TrendPoint {
  date: string;
  value: number;
}

/** 视图模式 */
type ViewMode = "grid" | "detail";

// ==================== 常量 ====================

const AUTO_REFRESH_INTERVAL = 30_000; // 30 秒自动刷新

// ==================== 页面组件 ====================

function DashboardContent() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [trendData, setTrendData] = useState<Record<string, TrendPoint[]>>({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 获取统计数据（供手动刷新和定时器调用）
  const fetchStats = useCallback(
    async (isManual = false) => {
      if (isManual) setRefreshing(true);
      try {
        const res = await fetch("/api/admin/stats");
        const data: Record<string, any> = await res.json();
        if (data.success && data.data) {
          setStats(data.data);
          setLastRefreshed(new Date());
        }
      } catch {
        if (isManual) {
          message.error(t("common.error"));
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [t]
  );

  // 自动刷新定时器（同时负责首次加载）
  useEffect(() => {
    // 首次立即加载
    const controller = new AbortController();
    fetch("/api/admin/stats", { signal: controller.signal })
      .then((res) => res.json())
      .then((value) => {
        const data = value as Record<string, any>;
        if (data.success && data.data) {
          setStats(data.data);
          setLastRefreshed(new Date());
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    // 设置定时刷新
    if (autoRefresh) {
      timerRef.current = setInterval(() => {
        fetchStats(false);
      }, AUTO_REFRESH_INTERVAL);
    }

    return () => {
      controller.abort();
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [autoRefresh, fetchStats]);

  // 获取趋势数据（用于详细视图的迷你图表）
  const fetchTrendData = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/usage/trend?period=today");
      const data: Record<string, any> = await res.json();
      if (data.success && Array.isArray(data.data)) {
        const trends: Record<string, TrendPoint[]> = {
          requests: [],
          tokens: [],
          avgTtft: [],
          avgDuration: [],
        };

        for (const point of data.data) {
          const reqs = point.requests || 0;
          const toks = point.tokens || 0;

          // 请求数和 Token 用量：使用 API 原始聚合值
          trends.requests.push({ date: point.date, value: reqs });
          trends.tokens.push({ date: point.date, value: toks });

          // 平均 TTFT / 耗时：API 未返回逐时段数据，不伪造
          // 保持空数组，图表组件会优雅降级
        }

        setTrendData(trends);
      }
    } catch {
      // 静默失败
    }
  }, []);

  // 手动刷新
  const handleRefresh = useCallback(() => {
    fetchStats(true);
    if (viewMode === "detail") {
      fetchTrendData();
    }
  }, [fetchStats, viewMode, fetchTrendData]);

  // 切换自动刷新
  const toggleAutoRefresh = useCallback(() => {
    setAutoRefresh((prev) => !prev);
  }, []);

  // 切换视图模式
  const toggleViewMode = useCallback(() => {
    setViewMode((prev) => (prev === "grid" ? "detail" : "grid"));
  }, []);

  // 视图切换时获取趋势数据
  useEffect(() => {
    if (viewMode === "detail" && stats) {
      const loadData = async () => {
        await fetchTrendData();
      };
      loadData();
    }
  }, [viewMode, stats, fetchTrendData]);

  // ==================== 统计卡片 ====================

  const statCards = [
    {
      key: "platforms",
      title: t("dashboard.active_platforms"),
      value: stats?.activePlatforms ?? 0,
      icon: <Cloud />,
      color: "bg-blue-50",
      iconColor: "text-blue-500",
    },
    {
      key: "keys",
      title: t("dashboard.active_keys"),
      value: stats?.activeKeys ?? 0,
      icon: <Key />,
      color: "bg-blue-50",
      iconColor: "text-blue-500",
    },
    {
      key: "requests",
      title: t("dashboard.total_requests"),
      value: stats?.totalRequests ?? 0,
      icon: <Globe />,
      color: "bg-blue-50",
      iconColor: "text-blue-500",
    },
    {
      key: "tokens",
      title: t("dashboard.total_tokens"),
      value: stats?.totalTokens ?? 0,
      icon: <Database />,
      color: "bg-blue-50",
      iconColor: "text-blue-500",
    },
    {
      key: "avgTtft",
      title: "Avg TTFT",
      value: stats?.avgTtft ?? 0,
      icon: <Clock />,
      color: "bg-orange-50",
      iconColor: "text-orange-500",
      get display() { return formatDuration(this.value); },
    },
    {
      key: "avgDuration",
      title: "Avg Duration",
      value: stats?.avgDuration ?? 0,
      icon: <Clock />,
      color: "bg-cyan-50",
      iconColor: "text-cyan-500",
      get display() { return formatDuration(this.value); },
    },
  ];

  // 获取图表颜色（与卡片配色统一）
  const getChartColor = (key: string): string => {
    const colorMap: Record<string, string> = {
      platforms: "#3b82f6",
      keys: "#3b82f6",
      requests: "#3b82f6",
      tokens: "#3b82f6",
      avgTtft: "#f97316",
      avgDuration: "#06b6d4",
    };
    return colorMap[key] || "#6b7280";
  };

  // ==================== 渲染 ====================

  if (loading && !stats) {
    return <GlobalLoading size="large" />;
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<LayoutDashboard size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title={t("dashboard.adminConsole")}
        description={
          <div className="flex flex-col">
            <span>{t("dashboard.adminConsoleDesc")}</span>
            {lastRefreshed && (
              <span className="text-xs text-zinc-400 mt-0.5">
                {t("dashboard.last_refreshed") || "上次刷新"}: {lastRefreshed.toLocaleTimeString()}
              </span>
            )}
          </div>
        }
        extra={
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={viewMode === "grid" ? <List size={14} /> : <Grid size={14} />}
              onClick={toggleViewMode}
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={autoRefresh ? <Pause size={14} /> : <Play size={14} />}
              onClick={toggleAutoRefresh}
              className="text-zinc-500"
            />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
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
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 mb-6">
          {statCards.map((card) => {
            const displayVal = "display" in card && card.display
              ? card.display.value
              : formatCompactNumber(card.value);
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
            const displayVal = "display" in card && card.display
              ? card.display.value
              : formatCompactNumber(card.value);
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

      {/* 最近事件 */}
      <ProCard
        title={
          <span className="font-semibold text-zinc-900">
            {t("dashboard.recent_events")}
          </span>
        }
      >
        <ResponsiveTable
          dataSource={stats?.recentEvents || []}
          rowKey="id"
          pagination={false}
          size="small"
          timeline
          timelineFields={{ level: "level", message: "message", time: "createdAt" }}
        />
      </ProCard>
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
