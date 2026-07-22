"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Tag, Tooltip, message } from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import {
  Cloud,
  Key,
  Globe,
  AlertTriangle,
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
        const data = await res.json();
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
      .then((data) => {
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
      // 获取最近 24 小时的趋势数据
      const res = await fetch("/api/admin/usage/trend?period=today");
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        // 转换为各指标的趋势数据
        const trends: Record<string, TrendPoint[]> = {
          requests: [],
          tokens: [],
          avgTtft: [],
          avgDuration: [],
        };

        let cumulativeRequests = 0;
        let cumulativeTokens = 0;
        let ttftSum = 0;
        let durationSum = 0;
        let count = 0;

        data.data.forEach((point: { date: string; requests: number; tokens: number }) => {
          cumulativeRequests += point.requests;
          cumulativeTokens += point.tokens;
          ttftSum += point.requests * (stats?.avgTtft || 0);
          durationSum += point.requests * (stats?.avgDuration || 0);
          count += point.requests;

          trends.requests.push({ date: point.date, value: cumulativeRequests });
          trends.tokens.push({ date: point.date, value: cumulativeTokens });
          trends.avgTtft.push({ date: point.date, value: count > 0 ? Math.round(ttftSum / count) : 0 });
          trends.avgDuration.push({ date: point.date, value: count > 0 ? Math.round(durationSum / count) : 0 });
        });

        setTrendData(trends);
      }
    } catch {
      // 静默失败
    }
  }, [stats]);

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

  // ==================== 表格列 ====================

  const eventColumns = [
    {
      title: t("common.status"),
      dataIndex: "level",
      key: "level",
      render: (level: string) => {
        const colorMap: Record<string, string> = {
          info: "blue",
          warning: "orange",
          error: "red",
          critical: "magenta",
        };
        return <Tag color={colorMap[level] || "default"}>{level}</Tag>;
      },
    },
    { title: t("common.message"), dataIndex: "message", key: "message" },
    {
      title: t("common.created_at"),
      dataIndex: "createdAt",
      key: "createdAt",
      render: (v: string) => new Date(v).toLocaleString(),
    },
  ];

  // ==================== 统计卡片 ====================

  const statCards = [
    {
      key: "platforms",
      title: t("dashboard.active_platforms"),
      value: stats?.activePlatforms ?? 0,
      icon: <Cloud />,
      color: "bg-emerald-50",
      iconColor: "text-emerald-500",
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
      color: "bg-amber-50",
      iconColor: "text-amber-500",
    },
    {
      key: "tokens",
      title: t("dashboard.total_tokens"),
      value: stats?.totalTokens ?? 0,
      icon: <AlertTriangle />,
      color: "bg-purple-50",
      iconColor: "text-purple-500",
    },
    {
      key: "avgTtft",
      title: t("usage.avg_ttft"),
      value: stats?.avgTtft ?? 0,
      suffix: "ms",
      icon: <Clock />,
      color: "bg-orange-50",
      iconColor: "text-orange-500",
    },
    {
      key: "avgDuration",
      title: t("usage.avg_duration"),
      value: stats?.avgDuration ?? 0,
      suffix: "ms",
      icon: <Clock />,
      color: "bg-cyan-50",
      iconColor: "text-cyan-500",
    },
  ];

  // 获取图表颜色
  const getChartColor = (key: string): string => {
    const colorMap: Record<string, string> = {
      platforms: "#10b981",
      keys: "#3b82f6",
      requests: "#f59e0b",
      tokens: "#a855f7",
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
          lastRefreshed
            ? `${t("dashboard.adminConsoleDesc")} · ${t("dashboard.last_refreshed") || "上次刷新"}: ${lastRefreshed.toLocaleTimeString()}`
            : t("dashboard.adminConsoleDesc")
        }
        extra={
          <div className="flex items-center gap-2">
            <Tooltip
              title={viewMode === "grid" ? "切换到详细视图" : "切换到网格视图"}
            >
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={viewMode === "grid" ? <List size={14} /> : <Grid size={14} />}
                onClick={toggleViewMode}
              />
            </Tooltip>
            <Tooltip
              title={
                autoRefresh
                  ? t("dashboard.pause_auto_refresh") || "暂停自动刷新"
                  : t("dashboard.resume_auto_refresh") || "开启自动刷新"
              }
            >
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={autoRefresh ? <Pause size={14} /> : <Play size={14} />}
                onClick={toggleAutoRefresh}
                className={autoRefresh ? "text-emerald-500" : "text-zinc-400"}
              />
            </Tooltip>
            <Button
              variant="default"
              icon={<RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />}
              onClick={handleRefresh}
              disabled={refreshing}
            >
              {t("common.refresh")}
            </Button>
          </div>
        }
      />

      {/* 统计卡片 */}
      {viewMode === "grid" ? (
        // 网格视图：一行多个
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
          {statCards.map((card) => (
            <ProCard key={card.key} className="bg-white border-zinc-200" padding="p-4">
              <div className="flex items-center gap-3">
                <div className={`h-9 w-9 ${card.color} rounded-lg flex items-center justify-center`}>
                  <span className={`${card.iconColor}`}>{card.icon}</span>
                </div>
                <div>
                  <p className="text-zinc-500 text-xs">{card.title}</p>
                  <p className="text-xl font-bold text-zinc-900">
                    {card.value.toLocaleString()}
                    {card.suffix && (
                      <span className="text-sm font-normal text-zinc-400 ml-1">
                        {card.suffix}
                      </span>
                    )}
                  </p>
                </div>
              </div>
            </ProCard>
          ))}
        </div>
      ) : (
        // 详细视图：一行一个，带趋势图
        <div className="space-y-3 mb-6">
          {statCards.map((card) => (
            <ProCard key={card.key} className="bg-white border-zinc-200" padding="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`h-10 w-10 ${card.color} rounded-lg flex items-center justify-center`}>
                    <span className={`${card.iconColor} text-lg`}>{card.icon}</span>
                  </div>
                  <div>
                    <p className="text-zinc-500 text-xs">{card.title}</p>
                    <p className="text-2xl font-bold text-zinc-900">
                      {card.value.toLocaleString()}
                      {card.suffix && (
                        <span className="text-sm font-normal text-zinc-400 ml-1">
                          {card.suffix}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                {/* 趋势图 */}
                <div className="w-24 h-10">
                  {trendData[card.key] && trendData[card.key].length > 0 ? (
                    <MiniTrendChart
                      data={trendData[card.key]}
                      color={getChartColor(card.key)}
                    />
                  ) : (
                    <div className="w-full h-full bg-zinc-50 dark:bg-zinc-800 rounded flex items-center justify-center">
                      <span className="text-xs text-zinc-300">--</span>
                    </div>
                  )}
                </div>
              </div>
            </ProCard>
          ))}
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
          columns={eventColumns}
          dataSource={stats?.recentEvents || []}
          rowKey="id"
          pagination={false}
          size="small"
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
