import { useEffect } from "react";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import GlobalLoading from "@/components/Loading";
import AdminLayout from "@/components/AdminLayout";
import { PlatformList, type Platform } from "@/components/platform/PlatformList";

/**
 * 平台列表页 — 分组列表
 * 整行点击进入独立路由 /admin/platforms/[id]（桌面端右侧展示详情，移动端全屏）
 */
export default function PlatformsPage() {
  const { t } = useTranslation("common");

  // 数据层：SWR 缓存 + 统一 fetcher（401 由 fetcher 统一提示并跳转登录页）
  const { data: platforms, error, isLoading, isValidating } = useApi<Platform[]>("/api/admin/platforms");

  // 请求失败提示
  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("error"));
    }
  }, [error, t]);

  if (isLoading && !platforms) {
    return <AdminLayout><GlobalLoading size="large" /></AdminLayout>;
  }

  return (
    <AdminLayout>
      <div className="max-w-2xl mx-auto">
        <PlatformList
          platforms={platforms ?? []}
          loading={isValidating}
          className="rounded-xl shadow-sm overflow-hidden"
        />
      </div>
    </AdminLayout>
  );
}
