"use client";

import { useState, useEffect } from "react";
import { Card, Table, Tag, message } from "antd";
import {
  CloudServerOutlined,
  KeyOutlined,
  ApiOutlined,
  AlertOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

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

export default function DashboardPage() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = async () => {
    try {
      const res = await fetch("/api/admin/stats");
      const data = await res.json();
      if (data.success && data.data) {
        setStats(data.data);
      }
    } catch (err) {
      console.error("获取统计数据失败:", err);
      message.error(t("common.error"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchStats();
  }, []);

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

  const statCards = [
    {
      key: "platforms",
      title: t("dashboard.active_platforms"),
      desc: t("dashboard.active_platforms_desc"),
      value: stats?.activePlatforms ?? 0,
      icon: <CloudServerOutlined />,
      color: "bg-emerald-50 dark:bg-emerald-500/10",
      iconColor: "text-emerald-500",
    },
    {
      key: "keys",
      title: t("dashboard.active_keys"),
      desc: t("dashboard.active_keys_desc"),
      value: stats?.activeKeys ?? 0,
      icon: <KeyOutlined />,
      color: "bg-blue-50 dark:bg-blue-500/10",
      iconColor: "text-blue-500",
    },
    {
      key: "requests",
      title: t("dashboard.total_requests"),
      desc: t("dashboard.total_requests_desc"),
      value: stats?.totalRequests ?? 0,
      icon: <ApiOutlined />,
      color: "bg-amber-50 dark:bg-amber-500/10",
      iconColor: "text-amber-500",
    },
    {
      key: "tokens",
      title: t("dashboard.total_tokens"),
      desc: t("dashboard.total_tokens_desc"),
      value: stats?.totalTokens ?? 0,
      icon: <AlertOutlined />,
      color: "bg-purple-50 dark:bg-purple-500/10",
      iconColor: "text-purple-500",
    },
  ];

  return (
    <div>
      {loading && !stats ? (
        <GlobalLoading size="large" />
      ) : (
        <>
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-1">
              {t("dashboard.adminConsole")}
            </h1>
            <p className="text-zinc-500 dark:text-zinc-400 text-sm">
              {t("dashboard.adminConsoleDesc")}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {statCards.map((card) => (
              <div
                key={card.key}
                role="article"
                aria-label={card.title}
                className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-100 dark:border-zinc-800 p-5 hover:shadow-lg hover:shadow-zinc-100 dark:hover:shadow-zinc-800/50 transition-all duration-300 group"
              >
                <div className="flex items-start justify-between mb-4">
                  <div
                    className={`w-10 h-10 ${card.color} rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform duration-300`}
                  >
                    <span className={`${card.iconColor} text-lg`}>{card.icon}</span>
                  </div>
                </div>
                <div className="text-3xl font-black text-zinc-900 dark:text-zinc-100 mb-1">
                  {card.value.toLocaleString()}
                </div>
                <div className="text-xs text-zinc-400 dark:text-zinc-500 font-medium">
                  {card.title}
                </div>
                <div className="text-[11px] text-zinc-300 dark:text-zinc-600 mt-0.5">
                  {card.desc}
                </div>
              </div>
            ))}
          </div>

          <Card
            title={
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                {t("dashboard.recent_events")}
              </span>
            }
            className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
            styles={{
              header: {
                borderBottom: "1px solid #f4f4f5",
              },
            }}
          >
            <div className="overflow-x-auto">
              <Table
                columns={eventColumns}
                dataSource={stats?.recentEvents || []}
                rowKey="id"
                pagination={false}
                size="small"
                aria-label={t("dashboard.recent_events")}
              />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
