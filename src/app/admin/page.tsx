"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Tag, message, Tooltip } from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import {
  CloudServerOutlined,
  KeyOutlined,
  ApiOutlined,
  AlertOutlined,
  DashboardOutlined,
  ReloadOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

// ==================== 类型定义 ====================

interface Stats {
  totalPlatforms: number;
  activePlatforms: number;
  totalKeys: number;
  activeKeys: number;
  totalRequests: number;
  errorRequests: number;
  totalTokens: number;
  recentEvents: Array<{
    id: string;
    level: string;
    message: string;
    createdAt: string;
  }>;
}

// ==================== 常量 ====================

const AUTO_REFRESH_INTERVAL = 30_000; // 30 秒自动刷新

// ==================== 页面组件 ====================

export default function DashboardPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
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

  // 手动刷新
  const handleRefresh = useCallback(() => {
    fetchStats(true);
  }, [fetchStats]);

  // 切换自动刷新
  const toggleAutoRefresh = useCallback(() => {
    setAutoRefresh((prev) => !prev);
  }, []);

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
      icon: <CloudServerOutlined />,
      color: "bg-emerald-50",
      iconColor: "text-emerald-500",
    },
    {
      key: "keys",
      title: t("dashboard.active_keys"),
      value: stats?.activeKeys ?? 0,
      icon: <KeyOutlined />,
      color: "bg-blue-50",
      iconColor: "text-blue-500",
    },
    {
      key: "requests",
      title: t("dashboard.total_requests"),
      value: stats?.totalRequests ?? 0,
      icon: <ApiOutlined />,
      color: "bg-amber-50",
      iconColor: "text-amber-500",
    },
    {
      key: "tokens",
      title: t("dashboard.total_tokens"),
      value: stats?.totalTokens ?? 0,
      icon: <AlertOutlined />,
      color: "bg-purple-50",
      iconColor: "text-purple-500",
    },
  ];

  // ==================== 渲染 ====================

  if (loading && !stats) {
    return <GlobalLoading size="large" />;
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<DashboardOutlined size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title={t("dashboard.adminConsole")}
        description={
          lastRefreshed
            ? `${t("dashboard.adminConsoleDesc")} · ${t("dashboard.last_refreshed") || "上次刷新"}: ${lastRefreshed.toLocaleTimeString()}`
            : t("dashboard.adminConsoleDesc")
        }
        extra={
          <div className="flex items-center gap-2">
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
                icon={autoRefresh ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                onClick={toggleAutoRefresh}
                className={autoRefresh ? "text-emerald-500" : "text-zinc-400"}
              />
            </Tooltip>
            <Button
              variant="default"
              icon={<ReloadOutlined className={refreshing ? "animate-spin" : ""} />}
              onClick={handleRefresh}
              disabled={refreshing}
            >
              {t("common.refresh")}
            </Button>
          </div>
        }
      />

      {/* 统计卡片 */}
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
                </p>
              </div>
            </div>
          </ProCard>
        ))}
      </div>

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
