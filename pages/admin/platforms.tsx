import { useState, useEffect } from "react";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";
import AdminLayout from "@/components/AdminLayout";
import { PlatformList, type Platform } from "@/components/platform/PlatformList";

/**
 * 平台列表页 — LobeChat 风格分组列表
 * 整行点击进入独立路由 /admin/platforms/[id]（桌面端右侧展示详情，移动端全屏）
 */
export default function PlatformsPage() {
  const { t } = useTranslation("common");
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const fetchPlatforms = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/platforms", { signal: controller.signal });
        const data = await res.json() as Record<string, any>;
        if (data.success && Array.isArray(data.data)) setPlatforms(data.data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error(t("error"));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    fetchPlatforms();
    return () => controller.abort();
  }, [t]);

  if (loading && platforms.length === 0) {
    return <AdminLayout><GlobalLoading size="large" /></AdminLayout>;
  }

  return (
    <AdminLayout>
      <div className="max-w-2xl mx-auto">
        <PlatformList
          platforms={platforms}
          loading={loading}
          className="rounded-xl shadow-sm overflow-hidden"
        />
      </div>
    </AdminLayout>
  );
}
