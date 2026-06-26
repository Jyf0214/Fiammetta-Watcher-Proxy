"use client";

import { useState, useEffect } from "react";
import { Card, Row, Col, Statistic, Table, Tag, message } from "antd";
import {
  CloudServerOutlined,
  KeyOutlined,
  ApiOutlined,
  AlertOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

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

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const res = await fetch("/api/admin/stats");
      const data = await res.json();
      if (data.success) {
        setStats(data.data);
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setLoading(false);
    }
  };

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

  return (
    <div>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title={t("dashboard.active_platforms")}
              value={stats?.activePlatforms ?? 0}
              prefix={<CloudServerOutlined />}
              loading={loading}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title={t("dashboard.active_keys")}
              value={stats?.activeKeys ?? 0}
              prefix={<KeyOutlined />}
              loading={loading}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title={t("dashboard.total_requests")}
              value={stats?.totalRequests ?? 0}
              prefix={<ApiOutlined />}
              loading={loading}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title={t("dashboard.total_tokens")}
              value={stats?.totalTokens ?? 0}
              prefix={<AlertOutlined />}
              loading={loading}
            />
          </Card>
        </Col>
      </Row>

      <Card title={t("dashboard.recent_events")} className="mt-4">
        <Table
          columns={eventColumns}
          dataSource={stats?.recentEvents || []}
          rowKey="id"
          pagination={false}
          size="small"
        />
      </Card>
    </div>
  );
}
