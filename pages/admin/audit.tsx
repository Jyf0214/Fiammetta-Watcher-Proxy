/**
 * 审计日志页面
 *
 * 功能：管理员操作审计日志列表，支持分页
 *
 * 主分支对应文件：src/app/admin/audit/page.tsx
 * 迁移变更：
 * - @lobehub/ui → Ant Design 5 原生组件
 * - 自定义组件（ResponsiveTable/PageContainer/PageHeader/ProCard）→ Ant Design 标准组件
 * - react-i18next → 中文直接写死
 * - useRouter from next/navigation → next/router（Pages Router）
 * - src/app/admin/audit/page.tsx → pages/admin/audit.tsx
 */

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import { Table, Tag, Button, Card, Space, message, Typography } from "antd";
import type { TableColumnsType } from "antd";

const { Title, Text } = Typography;

// ==================== 类型定义 ====================

/** 审计日志条目 */
interface AuditEntry {
  id: string;
  action: string;
  details: string | null;
  ipAddress: string | null;
  createdAt: number; // Unix 时间戳（秒）
  adminId: string;
}

// ==================== 操作类型颜色映射 ====================

const actionColorMap: Record<string, string> = {
  login: "blue",
  logout: "default",
  create_platform: "green",
  update_platform: "orange",
  delete_platform: "red",
  create_api_key: "green",
  update_api_key: "blue",
  delete_api_key: "red",
  create_model_map: "green",
  delete_model_map: "red",
  update_config: "orange",
  create_proxy: "green",
  delete_proxy: "red",
  archive_logs: "purple",
};

// ==================== 页面组件 ====================

export default function AuditPage() {
  const router = useRouter();
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  // 加载审计日志数据
  useEffect(() => {
    const controller = new AbortController();

    const fetchLogs = async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/admin/audit?page=${page}&pageSize=20`,
          { signal: controller.signal }
        );
        if (res.status === 401) {
          message.warning("登录已过期，请重新登录");
          router.push("/admin/login");
          return;
        }
        const data: any = await res.json();
        if (data.success) {
          if (data.data?.items) setLogs(data.data.items);
          if (data.data) setTotal(data.data.total);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error("获取审计日志失败");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    fetchLogs();
    return () => controller.abort();
  }, [page, router, refreshKey]);

  /** 刷新数据 */
  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  /** 格式化 Unix 时间戳为本地时间字符串 */
  const formatTime = (ts: number) => {
    return new Date(ts * 1000).toLocaleString("zh-CN");
  };

  /** 格式化操作名称为中文 */
  const formatAction = (action: string): string => {
    const actionMap: Record<string, string> = {
      login: "登录",
      logout: "登出",
      create_platform: "创建平台",
      update_platform: "更新平台",
      delete_platform: "删除平台",
      create_api_key: "创建 API Key",
      update_api_key: "更新 API Key",
      delete_api_key: "删除 API Key",
      create_model_map: "创建模型映射",
      delete_model_map: "删除模型映射",
      update_config: "更新配置",
      create_proxy: "创建代理",
      delete_proxy: "删除代理",
      archive_logs: "归档日志",
    };
    return actionMap[action] || action;
  };

  const columns: TableColumnsType<AuditEntry> = [
    {
      title: "时间",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (v: number) => formatTime(v),
    },
    {
      title: "管理员",
      dataIndex: "adminId",
      key: "adminId",
      width: 120,
      render: (v: string) => v || "-",
    },
    {
      title: "操作",
      dataIndex: "action",
      key: "action",
      width: 180,
      render: (v: string) => (
        <Tag color={actionColorMap[v] || "default"}>{formatAction(v)}</Tag>
      ),
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
          // 简洁显示：优先显示关键信息
          if (parsed.keyId) return `Key: ${parsed.keyId.slice(0, 8)}...`;
          if (parsed.platformId) return `平台: ${parsed.platformId.slice(0, 8)}...`;
          if (parsed.changes) {
            const keys = Object.keys(parsed.changes);
            return `变更: ${keys.join(", ")}`;
          }
          return v.length > 80 ? v.substring(0, 80) + "..." : v;
        } catch {
          return v.length > 80 ? v.substring(0, 80) + "..." : v;
        }
      },
    },
    {
      title: "IP",
      dataIndex: "ipAddress",
      key: "ipAddress",
      width: 140,
      render: (v: string | null) => v || "-",
    },
  ];

  return (
    <div style={{ padding: 24 }}>
      <Space align="center" style={{ marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          📜 审计日志
        </Title>
        <Text type="secondary">管理员操作记录</Text>
        <Button onClick={handleRefresh} loading={loading}>
          刷新
        </Button>
      </Space>

      <Card>
        <Table<AuditEntry>
          columns={columns}
          dataSource={logs}
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
