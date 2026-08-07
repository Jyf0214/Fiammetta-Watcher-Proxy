import { useState, useEffect } from "react";
import { Tag, Alert, Descriptions } from "antd";
import { Button } from "@/components/ui/Button";
import { RefreshCw, Settings } from "lucide-react";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import GlobalLoading from "@/components/Loading";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import AdminLayout from "@/components/AdminLayout";

interface SystemInfo {
  adminUsername: string;
  dbConnected: boolean;
  platformCount: number;
  keyCount: number;
}

export default function SystemPage() {
  const { t } = useTranslation("system");
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    const fetchInfo = async () => {
      try {
        const res = await fetch("/api/admin/stats", { signal: controller.signal });
        const data = await res.json() as Record<string, any>;
        if (data.success && data.data) {
          setInfo({
            adminUsername: data.data.adminUsername || "",
            dbConnected: data.data.dbConnected ?? false,
            platformCount: data.data.activePlatforms || 0,
            keyCount: data.data.activeKeys || 0,
          });
          setLoadError(false);
        } else {
          setLoadError(true);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoadError(true);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    fetchInfo();
    return () => controller.abort();
  }, [refreshKey]);

  if (loading) {
    return <AdminLayout><GlobalLoading size="large" /></AdminLayout>;
  }

  if (loadError) {
    return (
      <AdminLayout>
        <PageContainer>
          <PageHeader
            icon={<Settings size={20} className="text-zinc-500 dark:text-zinc-400" />}
            title={t("admin:system")}
            description={t("dbStatus")}
          />
          <ProCard>
            <Alert
              type="error"
              showIcon
              message={t("common:error")}
              description={
                <Button
                  variant="default"
                  onClick={() => { setLoadError(false); setLoading(true); setRefreshKey((k) => k + 1); }}
                  icon={<RefreshCw size={14} />}
                  size="sm"
                >
                  {t("common:refresh")}
                </Button>
              }
            />
          </ProCard>
        </PageContainer>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<Settings size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("admin:system")}
          description={t("dbStatus")}
        />

        <ProCard className="mb-4">
          <Descriptions column={1} bordered>
            <Descriptions.Item label={t("adminInit")}>
              {info?.adminUsername || t("common:notSet")}
            </Descriptions.Item>
            <Descriptions.Item label={t("dbStatus")}>
              <Tag color={info?.dbConnected ? "green" : "red"}>
                {info?.dbConnected
                  ? t("dbConnected")
                  : t("dbDisconnected")}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t("dashboard:activePlatforms")}>
              {info?.platformCount ?? 0}
            </Descriptions.Item>
            <Descriptions.Item label={t("dashboard:activeKeys")}>
              {info?.keyCount ?? 0}
            </Descriptions.Item>
          </Descriptions>
        </ProCard>
      </PageContainer>
    </AdminLayout>
  );
}
