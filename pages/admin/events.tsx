/**
 * 系统事件页面
 *
 * 功能：系统事件列表，支持分页、按类型筛选
 *
 * 主分支对应文件：src/app/admin/events/page.tsx
 * 迁移变更：
 * - @lobehub/ui → Ant Design 5 原生组件
 * - 自定义组件（ResponsiveTable/PageContainer/PageHeader/ProCard）→ Ant Design 标准组件
 * - react-i18next → 中文直接写死
 * - useRouter from next/navigation → next/router（Pages Router）
 * - src/app/admin/events/page.tsx → pages/admin/events.tsx
 * - 主分支从 /api/admin/logs?type=events 获取事件
 *   迁移后使用独立的 /api/admin/events 端点（对应 system_events 表）
 */

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { Table, Tag, Button, Card, Space, Select, message, Typography } from "antd";
import type { TableColumnsType } from "antd";

const { Title, Text } = Typography;

// ==================== 类型定义 ====================

/** 系统事件条目 */
interface EventEntry {
  id: string;
  type: string;
  message: string;
  details: string | null;
  createdAt: number; // Unix 时间戳（秒）
}

// ==================== 事件类型颜色映射 ====================

const typeColorMap: Record<string, string> = {
  info: "blue",
  warning: "orange",
  error: "red",
  critical: "magenta",
  success: "green",
  system: "purple",
};

// ==================== 页面组件 ====================

export default function EventsPage() {
  const router = useRouter();
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [typeFilter, setTypeFilter] = useState<string | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);

  // 加载事件数据
  useEffect(() => {
    const controller = new AbortController();

    const fetchEvents = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          page: String(page),
          pageSize: "20",
        });
        if (typeFilter) params.set("type", typeFilter);

        const res = await fetch(`/api/admin/events?${params}`, {
          signal: controller.signal,
        });
        if (res.status === 401) {
          message.warning("登录已过期，请重新登录");
          router.push("/admin/login");
          return;
        }
        const data: any = await res.json();
        if (data.success) {
          if (data.data?.items) setEvents(data.data.items);
          if (data.data) setTotal(data.data.total);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error("获取系统事件失败");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    fetchEvents();
    return () => controller.abort();
  }, [page, typeFilter, router, refreshKey]);

  /** 刷新数据 */
  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  /** 格式化 Unix 时间戳为本地时间字符串 */
  const formatTime = (ts: number) => {
    return new Date(ts * 1000).toLocaleString("zh-CN");
  };

  /** 格式化事件类型为中文 */
  const formatType = (type: string): string => {
    const typeMap: Record<string, string> = {
      info: "信息",
      warning: "警告",
      error: "错误",
      critical: "严重",
      success: "成功",
      system: "系统",
    };
    return typeMap[type] || type;
  };

  const columns: TableColumnsType<EventEntry> = [
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (v: number) => formatTime(v),
    },
    {
      title: "类型",
      dataIndex: "type",
      key: "type",
      width: 100,
      align: "center",
      render: (v: string) => (
        <Tag color={typeColorMap[v] || "default"}>{formatType(v)}</Tag>
      ),
    },
    {
      title: "消息",
      dataIndex: "message",
      key: "message",
      ellipsis: true,
    },
    {
      title: "详情",
      dataIndex: "details",
      key: "details",
      ellipsis: true,
      render: (v: string | null) => {
        if (!v) return "-";
        try {
          const parsed = JSON.parse(v);
          // 尝试提取可读内容
          if (parsed.content) return parsed.content;
          if (parsed.message) return parsed.message;
          // 显示 JSON 摘要
          const keys = Object.keys(parsed);
          if (keys.length <= 3) {
            return keys.map((k) => `${k}: ${parsed[k]}`).join(", ");
          }
          return v.length > 100 ? v.substring(0, 100) + "..." : v;
        } catch {
          return v.length > 100 ? v.substring(0, 100) + "..." : v;
        }
      },
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Space align="center" style={{ marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          ⚠️ 系统事件
        </Title>
        <Text type="secondary">系统运行事件记录</Text>
        <Select
          placeholder="按类型筛选"
          allowClear
          style={{ width: 130 }}
          value={typeFilter}
          onChange={(v) => {
            setTypeFilter(v);
            setPage(1);
          }}
          options={[
            { value: "info", label: "信息" },
            { value: "warning", label: "警告" },
            { value: "error", label: "错误" },
            { value: "critical", label: "严重" },
          ]}
        />
        <Button onClick={handleRefresh} loading={loading}>
          刷新
        </Button>
      </Space>

      <Card>
        <Table<EventEntry>
          columns={columns}
          dataSource={events}
          rowKey="id"
          loading={loading}
          pagination={{
            current: page,
            total,
            pageSize: 20,
            onChange: setPage,
            showTotal: (count) => `共 ${count} 条`,
          }}
          size="small"
        />
      </Card>
    </div>
  );
}
