"use client";

import { useState, useEffect } from "react";
import { Card, Descriptions, Tag } from "antd";
import GlobalLoading from "@/components/Loading";
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
    return <GlobalLoading size="large" />;
  }

  return (
    <div>
      <div className="border-b border-zinc-100 dark:border-zinc-800 pb-4 mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-1">
          {t("admin.system")}
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400 text-sm">
          {t("system.db_status")}
        </p>
      </div>

      <Card className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900" aria-label={t("admin.system")}>
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
