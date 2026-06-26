"use client";

import { useState, useEffect } from "react";
import { Card, Descriptions, Tag, Spin } from "antd";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

interface SystemInfo {
  adminUsername: string;
  dbConnected: boolean;
  platformCount: number;
  keyCount: number;
}

export default function SystemPage() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchInfo();
  }, []);

  const fetchInfo = async () => {
    try {
      const res = await fetch("/api/admin/stats");
      const data = await res.json();
      if (data.success) {
        setInfo({
          adminUsername: data.data.adminUsername || "",
          dbConnected: data.data.dbConnected ?? false,
          platformCount: data.data.activePlatforms || 0,
          keyCount: data.data.activeKeys || 0,
        });
      }
    } catch {
      setInfo({
        adminUsername: "",
        dbConnected: false,
        platformCount: 0,
        keyCount: 0,
      });
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div>
      <h3 className="mb-4">{t("admin.system")}</h3>
      <Card>
        <Descriptions column={1} bordered>
          <Descriptions.Item label={t("system.admin_init")}>
            {info?.adminUsername || t("common.not_set")}
          </Descriptions.Item>
          <Descriptions.Item label={t("system.db_status")}>
            <Tag color={info?.dbConnected ? "green" : "red"}>
              {info?.dbConnected
                ? t("system.db_connected")
                : t("system.db_disconnected")}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label={t("dashboard.active_platforms")}>
            {info?.platformCount ?? 0}
          </Descriptions.Item>
          <Descriptions.Item label={t("dashboard.active_keys")}>
            {info?.keyCount ?? 0}
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </div>
  );
}
