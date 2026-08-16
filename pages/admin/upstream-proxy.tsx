import { useState, useEffect } from "react";
import { Input, message } from "antd";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { AsyncBoundary } from "@/components/ui/AsyncBoundary";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { Globe, Save } from "lucide-react";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import AdminLayout from "@/components/AdminLayout";

/** 与 src/lib/upstream-proxy.ts 的 UPSTREAM_PROXY_CONFIG_KEY 保持一致 */
const CONFIG_KEY = "system:upstream_proxy";

export default function UpstreamProxyPage() {
  const { t } = useTranslation("system");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const { data: config, error, isLoading, mutate } = useApi<Record<string, string>>("/api/admin/config");

  // 配置就绪/变化时回填当前代理地址（渲染期 state 同步，避免 effect 内
  // setState；保存成功后 mutate 触发 config 更新，输入框值即保存值，回填无副作用）
  const [prevConfig, setPrevConfig] = useState<Record<string, string> | undefined>(undefined);
  if (config && prevConfig !== config) {
    setPrevConfig(config);
    setUrl(config[CONFIG_KEY] ?? "");
  }

  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [error, t]);

  const deployPlatform = process.env.NEXT_PUBLIC_DEPLOY_PLATFORM || "";
  const isDocker = deployPlatform === "docker";

  const save = async () => {
    const trimmed = url.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      message.error(t("upstreamProxyUrlInvalid"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: CONFIG_KEY, value: trimmed }),
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        mutate();
        message.success(t("upstreamProxySaved"));
      } else {
        message.error(data.error?.message ?? t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setSaving(false);
    }
  };

  if (isLoading && !config) {
    return (
      <AdminLayout>
        <PageContainer>
          <AsyncBoundary isLoading error={null}>
            <></>
          </AsyncBoundary>
        </PageContainer>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<Globe size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("upstreamProxyTitle")}
          description={t("upstreamProxyDesc")}
        />
        <ProCard>
          <div className="space-y-4">
            <div
              className={`rounded-lg px-3 py-2 text-xs ${
                isDocker
                  ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400"
                  : "bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400"
              }`}
            >
              {t("upstreamProxyPlatform")}：{deployPlatform || "—"}。
              {isDocker ? t("upstreamProxyActive") : t("upstreamProxyNotActive")}
            </div>
            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {t("upstreamProxyUrlLabel")}
              </label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t("upstreamProxyUrlPlaceholder")}
                allowClear
              />
              <p className="text-xs text-zinc-400 mt-1">{t("upstreamProxyUrlHelp")}</p>
            </div>
            <Button variant="primary" size="sm" onClick={save} loading={saving} icon={<Save size={14} />}>
              {t("common:save")}
            </Button>
          </div>
        </ProCard>
      </PageContainer>
    </AdminLayout>
  );
}