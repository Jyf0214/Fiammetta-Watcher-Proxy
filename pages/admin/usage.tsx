/**
 * 用量统计页（含 Key/平台/趋势 Tab）
 *
 * 功能：
 * - Tab 1: Key 用量（按 API Key 统计请求数、Token 数、TTFT 等）
 * - Tab 2: 平台用量（按平台统计请求数、Token 数、错误率等）
 * - Tab 3: 趋势图（Recharts 折线图，请求+Token 双轴）
 * - 时间范围选择器（今日/本周/本月/全部）
 *
 * API 端点：
 * - GET /api/admin/usage?period=xxx — Key 用量
 * - GET /api/admin/usage/platform?period=xxx — 平台用量
 * - GET /api/admin/usage/trend?period=xxx — 趋势数据
 */

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  Card,
  Tabs,
  Table,
  Tag,
  Select,
  Space,
  Row,
  Col,
  Statistic,
  Spin,
  Alert,
  Typography,
  Button,
  Tooltip,
} from "antd";
import type { TableColumnsType } from "antd";
import {
  BarChartOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  RiseOutlined,
  CloudServerOutlined,
  WarningOutlined,
  ClockCircleOutlined,
  KeyOutlined,
} from "@ant-design/icons";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
} from "recharts";

const { Title, Text } = Typography;

// ==================== 类型定义 ====================

interface TrendPoint {
  date: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
}

interface KeyUsage {
  id: string;
  name: string;
  key: string;
  status: string;
  quota: number | null;
  usedTokens: number;
  createdAt: string;
  stats: {
    totalRequests: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    avgTtft: number;
    avgDuration: number;
  };
}

interface PlatformUsage {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  status: string;
  stats: {
    totalRequests: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    avgTtft: number;
    avgDuration: number;
    errorRequests: number;
  };
}

// ==================== 时间范围选项 ====================

const PERIOD_OPTIONS = [
  { value: "day", label: "今日" },
  { value: "week", label: "本周" },
  { value: "month", label: "本月" },
  { value: "all", label: "全部" },
];

// ==================== 统计卡片组件 ====================

function StatCard({
  title,
  value,
  suffix,
  icon,
  color,
}: {
  title: string;
  value: number;
  suffix?: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <Card size="small">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: `${color}15`,
          }}
        >
          <span style={{ color, fontSize: 18 }}>{icon}</span>
        </div>
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>{title}</Text>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#1f2937" }}>
            {value.toLocaleString()}
            {suffix && (
              <Text type="secondary" style={{ fontSize: 13, marginLeft: 4 }}>
                {suffix}
              </Text>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ==================== Key 用量 Tab ====================

function KeyUsageTab({ period, refreshKey }: { period: string; refreshKey: number }) {
  const [data, setData] = useState<KeyUsage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    const fetchData = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ period });
        const res = await fetch(`/api/admin/usage?${params}`, { signal: controller.signal });
        const json: any = await res.json();
        if (json.success && Array.isArray(json.data)) {
          setData(json.data);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchData();
    return () => controller.abort();
  }, [period, refreshKey]);

  const summary = useMemo(
    () => ({
      totalRequests: data.reduce((s, k) => s + k.stats.totalRequests, 0),
      totalTokens: data.reduce((s, k) => s + k.stats.totalTokens, 0),
      activeKeys: data.filter((k) => k.status === "active").length,
      avgTtft: data.length > 0 ? Math.round(data.reduce((s, k) => s + k.stats.avgTtft, 0) / data.length) : 0,
    }),
    [data],
  );

  const columns: TableColumnsType<KeyUsage> = [
    {
      title: "名称",
      dataIndex: "name",
      key: "name",
      width: 140,
      ellipsis: true,
    },
    {
      title: "密钥",
      dataIndex: "key",
      key: "key",
      width: 160,
      render: (v: string) => <span style={{ fontFamily: "monospace", fontSize: 12 }}>{v}</span>,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 80,
      align: "center",
      render: (v: string) => <Tag color={v === "active" ? "green" : "red"}>{v === "active" ? "启用" : "禁用"}</Tag>,
    },
    {
      title: "请求数",
      key: "totalRequests",
      width: 90,
      align: "right",
      render: (_: unknown, r: KeyUsage) => r.stats.totalRequests.toLocaleString(),
    },
    {
      title: "Token 总量",
      key: "totalTokens",
      width: 100,
      align: "right",
      render: (_: unknown, r: KeyUsage) => r.stats.totalTokens.toLocaleString(),
    },
    {
      title: <Tooltip title="平均首 Token 响应时间">TTFT</Tooltip>,
      key: "avgTtft",
      width: 80,
      align: "right",
      render: (_: unknown, r: KeyUsage) => (r.stats.avgTtft > 0 ? `${r.stats.avgTtft}ms` : "-"),
      responsive: ["md"],
    },
    {
      title: "平均耗时",
      key: "avgDuration",
      width: 90,
      align: "right",
      render: (_: unknown, r: KeyUsage) => (r.stats.avgDuration > 0 ? `${r.stats.avgDuration}ms` : "-"),
      responsive: ["lg"],
    },
  ];

  return (
    <>
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <StatCard title="总请求数" value={summary.totalRequests} icon={<ThunderboltOutlined />} color="#3b82f6" />
        </Col>
        <Col xs={12} sm={6}>
          <StatCard title="总 Token 数" value={summary.totalTokens} icon={<RiseOutlined />} color="#10b981" />
        </Col>
        <Col xs={12} sm={6}>
          <StatCard title="活跃密钥" value={summary.activeKeys} suffix={`/ ${data.length}`} icon={<KeyOutlined />} color="#8b5cf6" />
        </Col>
        <Col xs={12} sm={6}>
          <StatCard title="平均 TTFT" value={summary.avgTtft} suffix="ms" icon={<ClockCircleOutlined />} color="#f59e0b" />
        </Col>
      </Row>
      <Table
        columns={columns}
        dataSource={data}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 20, showTotal: (count) => `共 ${count} 条` }}
        scroll={{ x: 900 }}
      />
    </>
  );
}

// ==================== 平台用量 Tab ====================

function PlatformUsageTab({ period, refreshKey }: { period: string; refreshKey: number }) {
  const [data, setData] = useState<PlatformUsage[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    const fetchData = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ period });
        const res = await fetch(`/api/admin/usage/platform?${params}`, { signal: controller.signal });
        const json: any = await res.json();
        if (json.success && Array.isArray(json.data)) {
          setData(json.data);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchData();
    return () => controller.abort();
  }, [period, refreshKey]);

  const summary = useMemo(
    () => ({
      totalRequests: data.reduce((s, p) => s + p.stats.totalRequests, 0),
      totalTokens: data.reduce((s, p) => s + p.stats.totalTokens, 0),
      activePlatforms: data.filter((p) => p.enabled).length,
      errorRequests: data.reduce((s, p) => s + p.stats.errorRequests, 0),
    }),
    [data],
  );

  const statusColorMap: Record<string, string> = { healthy: "green", degraded: "orange", down: "red" };

  const columns: TableColumnsType<PlatformUsage> = [
    {
      title: "平台名称",
      dataIndex: "name",
      key: "name",
      width: 150,
      ellipsis: true,
    },
    {
      title: "类型",
      dataIndex: "type",
      key: "type",
      width: 80,
      render: (v: string) => <Tag color={v === "openai" ? "blue" : v === "azure" ? "purple" : "default"}>{v}</Tag>,
    },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 80,
      align: "center",
      render: (v: string) => <Tag color={statusColorMap[v] || "default"}>{v}</Tag>,
    },
    {
      title: "请求数",
      key: "totalRequests",
      width: 90,
      align: "right",
      render: (_: unknown, r: PlatformUsage) => r.stats.totalRequests.toLocaleString(),
    },
    {
      title: "Token 总量",
      key: "totalTokens",
      width: 100,
      align: "right",
      render: (_: unknown, r: PlatformUsage) => r.stats.totalTokens.toLocaleString(),
    },
    {
      title: "Prompt",
      key: "promptTokens",
      width: 90,
      align: "right",
      render: (_: unknown, r: PlatformUsage) => r.stats.promptTokens.toLocaleString(),
      responsive: ["md"],
    },
    {
      title: "Completion",
      key: "completionTokens",
      width: 100,
      align: "right",
      render: (_: unknown, r: PlatformUsage) => r.stats.completionTokens.toLocaleString(),
      responsive: ["md"],
    },
    {
      title: "错误",
      key: "errorRequests",
      width: 70,
      align: "right",
      render: (_: unknown, r: PlatformUsage) =>
        r.stats.errorRequests > 0 ? (
          <span style={{ color: "#ef4444" }}>{r.stats.errorRequests}</span>
        ) : (
          "0"
        ),
      responsive: ["lg"],
    },
    {
      title: <Tooltip title="平均首 Token 响应时间">TTFT</Tooltip>,
      key: "avgTtft",
      width: 80,
      align: "right",
      render: (_: unknown, r: PlatformUsage) => (r.stats.avgTtft > 0 ? `${r.stats.avgTtft}ms` : "-"),
      responsive: ["lg"],
    },
  ];

  return (
    <>
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={6}>
          <StatCard title="总请求数" value={summary.totalRequests} icon={<ThunderboltOutlined />} color="#3b82f6" />
        </Col>
        <Col xs={12} sm={6}>
          <StatCard title="总 Token 数" value={summary.totalTokens} icon={<RiseOutlined />} color="#10b981" />
        </Col>
        <Col xs={12} sm={6}>
          <StatCard title="活跃平台" value={summary.activePlatforms} suffix={`/ ${data.length}`} icon={<CloudServerOutlined />} color="#8b5cf6" />
        </Col>
        <Col xs={12} sm={6}>
          <StatCard title="错误数" value={summary.errorRequests} icon={<WarningOutlined />} color="#ef4444" />
        </Col>
      </Row>
      <Table
        columns={columns}
        dataSource={data}
        rowKey="id"
        loading={loading}
        size="small"
        pagination={{ pageSize: 20, showTotal: (count) => `共 ${count} 条` }}
        scroll={{ x: 1100 }}
      />
    </>
  );
}

// ==================== 趋势 Tab ====================

function TrendTab({ period, refreshKey }: { period: string; refreshKey: number }) {
  const [data, setData] = useState<TrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const fetchTrend = async () => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ period });
        const res = await fetch(`/api/admin/usage/trend?${params}`, { signal: controller.signal });
        const json: any = await res.json();
        if (json.success && Array.isArray(json.data)) {
          setData(json.data);
        } else {
          setError(json.error || "加载失败");
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "请求异常");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchTrend();
    return () => controller.abort();
  }, [period, refreshKey]);

  const chartData = useMemo(
    () =>
      data.map((d) => ({
        ...d,
        dateLabel: d.date.length > 10 ? d.date.slice(11, 16) : d.date.slice(5),
      })),
    [data],
  );

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return <Alert type="error" message="加载失败" description={error} showIcon />;
  }

  if (chartData.length === 0) {
    return <Alert type="info" message="暂无数据" description="当前时间范围内没有请求记录。" showIcon />;
  }

  return (
    <div style={{ height: 400 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="dateLabel"
            tick={{ fontSize: 12, fill: "#a1a1aa" }}
            tickLine={false}
          />
          <YAxis
            yAxisId="left"
            tick={{ fontSize: 12, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            tick={{ fontSize: 12, fill: "#a1a1aa" }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))}
          />
          <RechartsTooltip
            contentStyle={{
              backgroundColor: "#fff",
              border: "1px solid #e4e4e7",
              borderRadius: 8,
              fontSize: 13,
            }}
            formatter={((value: number, name: string) => [value.toLocaleString(), name]) as any}
          />
          <Legend wrapperStyle={{ fontSize: 13, paddingTop: 8 }} />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="requests"
            name="请求数"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="tokens"
            name="Token 数"
            stroke="#10b981"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ==================== 主页面 ====================

export default function UsagePage() {
  const [period, setPeriod] = useState("month");
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const tabItems = [
    {
      key: "key",
      label: (
        <Space>
          <KeyOutlined />
          <span>Key 用量</span>
        </Space>
      ),
      children: <KeyUsageTab period={period} refreshKey={refreshKey} />,
    },
    {
      key: "platform",
      label: (
        <Space>
          <CloudServerOutlined />
          <span>平台用量</span>
        </Space>
      ),
      children: <PlatformUsageTab period={period} refreshKey={refreshKey} />,
    },
    {
      key: "trend",
      label: (
        <Space>
          <BarChartOutlined />
          <span>趋势图</span>
        </Space>
      ),
      children: <TrendTab period={period} refreshKey={refreshKey} />,
    },
  ];

  return (
    <div>
      {/* 标题栏 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <Space>
          <BarChartOutlined style={{ fontSize: 20, color: "#6b7280" }} />
          <div>
            <Title level={4} style={{ margin: 0 }}>用量统计</Title>
            <Text type="secondary">API Key 和平台的使用数据</Text>
          </div>
        </Space>
        <Space>
          <Select
            value={period}
            onChange={setPeriod}
            options={PERIOD_OPTIONS}
            style={{ width: 100 }}
            size="middle"
          />
          <Button icon={<ReloadOutlined />} onClick={handleRefresh}>
            刷新
          </Button>
        </Space>
      </div>

      {/* Tab 内容 */}
      <Card>
        <Tabs
          defaultActiveKey="key"
          items={tabItems}
          style={{ minHeight: 400 }}
        />
      </Card>
    </div>
  );
}
