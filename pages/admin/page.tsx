/**
 * 仪表盘页面
 *
 * 功能：
 * - 统计卡片（活跃平台、活跃密钥、总请求数、总 Token、平均 TTFT、平均耗时）
 * - 趋势图（Recharts 迷你面积图）
 * - 最近系统事件
 * - 自动刷新（30秒间隔）
 * - 手动刷新按钮
 *
 * 主分支对应文件：src/app/admin/page.tsx
 * 迁移变更：
 * - @lobehub/ui Tag/Tooltip → Ant Design Tag/Tooltip
 * - 自定义组件 → Ant Design Card/Table
 * - lucide-react 图标 → @ant-design/icons
 * - Recharts 保留（轻量趋势图）
 * - react-i18next → 中文直接写死
 */

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Card, Table, Tag, Button, Tooltip, Typography, Spin, Space } from "antd";
import type { TableColumnsType } from "antd";
import {
  CloudServerOutlined,
  KeyOutlined,
  GlobalOutlined,
  AlertOutlined,
  ClockCircleOutlined,
  DashboardOutlined,
  ReloadOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
} from "@ant-design/icons";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";

const { Title, Text } = Typography;

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

// ==================== 迷你趋势图组件 ====================

function MiniTrendChart({ data, color = "#3b82f6", height = 40 }: { data: TrendPoint[]; color?: string; height?: number }) {
  const chartData = useMemo(() => data.map((d) => ({ value: d.value })), [data]);

  if (!data || data.length === 0) {
    return (
      <div style={{ width: "100%", height, background: "#f4f4f5", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: 12, color: "#d4d4d8" }}>--</span>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={chartData} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
        <defs>
          <linearGradient id={`gradient-${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          fill={`url(#gradient-${color.replace("#", "")})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ==================== 统计卡片配置 ====================

interface StatCard {
  key: string;
  title: string;
  value: number;
  suffix?: string;
  icon: React.ReactNode;
  color: string;
  iconColor: string;
  chartColor: string;
}

// ==================== 常量 ====================

const AUTO_REFRESH_INTERVAL = 30_000;

// ==================== 页面组件 ====================

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [trendData, setTrendData] = useState<Record<string, TrendPoint[]>>({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 获取统计数据
  const fetchStats = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const res = await fetch("/api/admin/stats");
      const data: any = await res.json();
      if (data.success && data.data) {
        setStats(data.data);
        setLastRefreshed(new Date());
      }
    } catch {
      if (isManual) {
        // 静默失败
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // 自动刷新
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/admin/stats", { signal: controller.signal })
      .then((res) => res.json() as any)
      .then((data) => {
        if (data.success && data.data) {
          setStats(data.data);
          setLastRefreshed(new Date());
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    if (autoRefresh) {
      timerRef.current = setInterval(() => fetchStats(false), AUTO_REFRESH_INTERVAL);
    }

    return () => {
      controller.abort();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh, fetchStats]);

  // 获取趋势数据
  const fetchTrendData = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/usage/trend?period=today");
      const data: any = await res.json();
      if (data.success && Array.isArray(data.data)) {
        const trends: Record<string, TrendPoint[]> = { requests: [], tokens: [], avgTtft: [], avgDuration: [] };
        let cumReq = 0, cumTok = 0, ttftSum = 0, durSum = 0, cnt = 0;
        data.data.forEach((point: { date: string; requests: number; tokens: number }) => {
          cumReq += point.requests;
          cumTok += point.tokens;
          ttftSum += point.requests * (stats?.avgTtft || 0);
          durSum += point.requests * (stats?.avgDuration || 0);
          cnt += point.requests;
          trends.requests.push({ date: point.date, value: cumReq });
          trends.tokens.push({ date: point.date, value: cumTok });
          trends.avgTtft.push({ date: point.date, value: cnt > 0 ? Math.round(ttftSum / cnt) : 0 });
          trends.avgDuration.push({ date: point.date, value: cnt > 0 ? Math.round(durSum / cnt) : 0 });
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
    fetchTrendData();
  }, [fetchStats, fetchTrendData]);

  // 统计卡片
  const statCards: StatCard[] = [
    { key: "platforms", title: "活跃平台", value: stats?.activePlatforms ?? 0, icon: <CloudServerOutlined />, color: "#ecfdf5", iconColor: "#10b981", chartColor: "#10b981" },
    { key: "keys", title: "活跃密钥", value: stats?.activeKeys ?? 0, icon: <KeyOutlined />, color: "#eff6ff", iconColor: "#3b82f6", chartColor: "#3b82f6" },
    { key: "requests", title: "总请求数", value: stats?.totalRequests ?? 0, icon: <GlobalOutlined />, color: "#fffbeb", iconColor: "#f59e0b", chartColor: "#f59e0b" },
    { key: "tokens", title: "总 Token", value: stats?.totalTokens ?? 0, icon: <AlertOutlined />, color: "#faf5ff", iconColor: "#a855f7", chartColor: "#a855f7" },
    { key: "avgTtft", title: "平均 TTFT", value: stats?.avgTtft ?? 0, suffix: "ms", icon: <ClockCircleOutlined />, color: "#fff7ed", iconColor: "#f97316", chartColor: "#f97316" },
    { key: "avgDuration", title: "平均耗时", value: stats?.avgDuration ?? 0, suffix: "ms", icon: <ClockCircleOutlined />, color: "#ecfeff", iconColor: "#06b6d4", chartColor: "#06b6d4" },
  ];

  // 事件表格列
  const eventColumns: TableColumnsType<any> = [
    {
      title: "级别",
      dataIndex: "level",
      key: "level",
      width: 80,
      render: (level: string) => {
        const colorMap: Record<string, string> = { info: "blue", warning: "orange", error: "red", critical: "magenta" };
        return <Tag color={colorMap[level] || "default"}>{level}</Tag>;
      },
    },
    { title: "消息", dataIndex: "message", key: "message", ellipsis: true },
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 160,
      render: (v: string) => {
        try { return new Date(v).toLocaleString(); } catch { return v; }
      },
    },
  ];

  // 加载中
  if (loading && !stats) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 400 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1024, margin: "0 auto", padding: "24px 0" }}>
      {/* 标题栏 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 40, height: 40,
            background: "#f4f4f5",
            borderRadius: 10,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <DashboardOutlined style={{ fontSize: 18, color: "#71717a" }} />
          </div>
          <div>
            <Title level={4} style={{ margin: 0, fontWeight: 700 }}>管理控制台</Title>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {lastRefreshed ? `上次刷新: ${lastRefreshed.toLocaleTimeString()}` : "数据概览"}
            </Text>
          </div>
        </div>
        <Space>
          <Tooltip title={autoRefresh ? "暂停自动刷新" : "开启自动刷新"}>
            <Button
              type="text"
              icon={autoRefresh ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={() => setAutoRefresh(!autoRefresh)}
              style={{ color: autoRefresh ? "#10b981" : undefined }}
            />
          </Tooltip>
          <Button
            icon={<ReloadOutlined spin={refreshing} />}
            onClick={handleRefresh}
            loading={refreshing}
          >
            刷新
          </Button>
        </Space>
      </div>

      {/* 统计卡片 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, marginBottom: 24 }}>
        {statCards.map((card) => (
          <Card key={card.key} size="small" style={{ borderRadius: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{
                  width: 36, height: 36,
                  background: card.color,
                  borderRadius: 8,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: card.iconColor,
                  fontSize: 16,
                }}>
                  {card.icon}
                </div>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{card.title}</Text>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#18181b" }}>
                    {card.value.toLocaleString()}
                    {card.suffix && (
                      <span style={{ fontSize: 12, fontWeight: 400, color: "#a1a1aa", marginLeft: 4 }}>
                        {card.suffix}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div style={{ width: 80, height: 36 }}>
                {trendData[card.key] && trendData[card.key].length > 0 ? (
                  <MiniTrendChart data={trendData[card.key]} color={card.chartColor} />
                ) : (
                  <div style={{ width: "100%", height: "100%", background: "#f4f4f5", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <span style={{ fontSize: 12, color: "#d4d4d8" }}>--</span>
                  </div>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* 最近事件 */}
      <Card
        title={
          <span style={{ fontWeight: 600 }}>最近系统事件</span>
        }
        style={{ borderRadius: 12 }}
      >
        <Table
          columns={eventColumns}
          dataSource={stats?.recentEvents || []}
          rowKey="id"
          pagination={false}
          size="small"
          locale={{ emptyText: "暂无事件" }}
        />
      </Card>
    </div>
  );
}
