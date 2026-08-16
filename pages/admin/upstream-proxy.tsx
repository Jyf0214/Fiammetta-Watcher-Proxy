import { useState, useEffect } from "react";
import { Input, Select, message } from "antd";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { AsyncBoundary } from "@/components/ui/AsyncBoundary";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { Globe, RefreshCw, Save } from "lucide-react";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import AdminLayout from "@/components/AdminLayout";

/** 与 src/lib/upstream-proxy.ts 的常量保持一致（前端不直接 import，避免引入服务端依赖） */
const CONFIG_KEY = "system:upstream_proxy";
const HEALTH_KEY = "system:upstream_proxy_health";
const DEFAULT_CHECK_URL = "https://www.google.com/generate_204";

interface ProxyHealthEntry {
  status: "ok" | "fail";
  latencyMs: number;
  /** unix 秒 */
  checkedAt: number;
  failCount: number;
}
type ProxyHealthMap = Record<string, ProxyHealthEntry>;

interface ProxyConfigShape {
  urls?: string[];
  platformIds?: string[];
  healthCheckUrl?: string;
}

/** 解析代理配置（兼容旧版纯 URL 字符串与数组格式，与后端 parseProxyConfig 对齐） */
function parseProxyConfig(raw: string | undefined): ProxyConfigShape {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    if (typeof parsed === "string") return { urls: [parsed] };
    if (Array.isArray(parsed)) return { urls: parsed.filter((u): u is string => typeof u === "string") };
    return {};
  } catch {
    return { urls: [raw] };
  }
}

/** 解析健康度记录（容忍脏数据） */
function parseHealthMap(raw: string | undefined): ProxyHealthMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: ProxyHealthMap = {};
    for (const [url, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (e.status !== "ok" && e.status !== "fail") continue;
      map[url] = {
        status: e.status,
        latencyMs: typeof e.latencyMs === "number" ? e.latencyMs : 0,
        checkedAt: typeof e.checkedAt === "number" ? e.checkedAt : 0,
        failCount: typeof e.failCount === "number" ? e.failCount : 0,
      };
    }
    return map;
  } catch {
    return {};
  }
}

export default function UpstreamProxyPage() {
  const { t } = useTranslation("system");
  const [urlsText, setUrlsText] = useState("");
  const [platformIds, setPlatformIds] = useState<string[]>([]);
  const [checkUrl, setCheckUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const { data: config, error, isLoading, mutate } = useApi<Record<string, string>>("/api/admin/config");
  const { data: platforms } = useApi<{ id: string; name: string }[]>("/api/admin/platforms");

  // 首次加载完成/服务器配置值变化时回填表单（渲染期 state 同步 prev 值比较，
  // 避免 effect 内 setState 与渲染期读 ref）。
  // 用户编辑中 config 引用因 SWR 重新验证而变化但值未变 → 不回填，不覆盖
  // 未保存的编辑；保存后 mutate 的 config 值即用户输入值，回填无副作用；
  // 其他管理员修改了配置（值真变）→ 回填同步最新值
  const [prevConfigValue, setPrevConfigValue] = useState<string | undefined>(undefined);
  if (config && prevConfigValue !== config[CONFIG_KEY]) {
    setPrevConfigValue(config[CONFIG_KEY]);
    const parsed = parseProxyConfig(config[CONFIG_KEY]);
    setUrlsText((parsed.urls ?? []).join("\n"));
    setPlatformIds(parsed.platformIds ?? []);
    setCheckUrl(parsed.healthCheckUrl ?? "");
  }

  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [error, t]);

  const deployPlatform = process.env.NEXT_PUBLIC_DEPLOY_PLATFORM || "";
  const isDocker = deployPlatform === "docker";

  const healthMap = parseHealthMap(config?.[HEALTH_KEY]);
  const urls = [...new Set(urlsText.split("\n").map((s) => s.trim()).filter(Boolean))];

  const save = async () => {
    if (urls.some((u) => !/^https?:\/\//i.test(u))) {
      message.error(t("upstreamProxyInvalidUrls"));
      return;
    }
    const checkUrlTrimmed = checkUrl.trim();
    if (checkUrlTrimmed && !/^https?:\/\//i.test(checkUrlTrimmed)) {
      message.error(t("upstreamProxyInvalidUrls"));
      return;
    }
    // 全空时保存空配置 "{}"（后端解析为空对象 → 直连；空串也能通过 config
    // API 的字符串校验，但 "{}" 语义更明确，且与后端 JSON 解析路径一致）
    const value = urls.length === 0
      ? "{}"
      : JSON.stringify({ urls, platformIds, healthCheckUrl: checkUrlTrimmed || DEFAULT_CHECK_URL });
    setSaving(true);
    try {
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: CONFIG_KEY, value }),
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

  const checkNow = async () => {
    // 「立即检查」作用于已保存配置：输入与已保存不一致时提示先保存，
    // 避免检查结果与页面显示对不上
    const saved = parseProxyConfig(config?.[CONFIG_KEY]);
    const savedUrls = [...new Set((saved.urls ?? []).map((u) => u.trim()).filter(Boolean))].sort();
    if (JSON.stringify(urls.slice().sort()) !== JSON.stringify(savedUrls)) {
      message.warning(t("upstreamProxySaveFirst"));
      return;
    }
    setChecking(true);
    try {
      const res = await fetch("/api/admin/upstream-proxy/health", { method: "POST" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        mutate();
        message.success(t("upstreamProxyHealthDone"));
      } else {
        message.error(data.error?.message ?? t("common:error"));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setChecking(false);
    }
  };

  // 加载失败且无数据：渲染错误态而非空表单，防止用户误保存空配置覆盖真实配置
  if (error && !config) {
    return (
      <AdminLayout>
        <PageContainer>
          <AsyncBoundary isLoading={false} error={error}>
            <></>
          </AsyncBoundary>
        </PageContainer>
      </AdminLayout>
    );
  }

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
                {t("upstreamProxyUrlsLabel")}
              </label>
              <Input.TextArea
                value={urlsText}
                onChange={(e) => setUrlsText(e.target.value)}
                placeholder={"http://127.0.0.1:7890\nhttp://127.0.0.1:7891"}
                rows={3}
                allowClear
              />
              <p className="text-xs text-zinc-400 mt-1">{t("upstreamProxyUrlsHelp")}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {t("upstreamProxyPlatformsLabel")}
              </label>
              <Select
                mode="multiple"
                value={platformIds}
                onChange={(v: string[]) => setPlatformIds(v)}
                options={(platforms ?? []).map((p) => ({ label: p.name, value: p.id }))}
                placeholder={t("upstreamProxyPlatformsPlaceholder")}
                allowClear
                className="w-full"
                maxTagCount={4}
              />
              <p className="text-xs text-zinc-400 mt-1">{t("upstreamProxyPlatformsHelp")}</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {t("upstreamProxyCheckUrlLabel")}
              </label>
              <Input
                value={checkUrl}
                onChange={(e) => setCheckUrl(e.target.value)}
                placeholder={DEFAULT_CHECK_URL}
                allowClear
              />
              <p className="text-xs text-zinc-400 mt-1">{t("upstreamProxyCheckUrlHelp")}</p>
            </div>

            {isDocker && (
              <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                    {t("upstreamProxyHealthTitle")}
                  </span>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={checkNow}
                    loading={checking}
                    icon={<RefreshCw size={14} />}
                    disabled={urls.length === 0}
                  >
                    {t("upstreamProxyCheckNow")}
                  </Button>
                </div>
                {urls.length === 0 ? (
                  <p className="text-xs text-zinc-400">{t("upstreamProxyHealthEmpty")}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {urls.map((url) => {
                      const entry = healthMap[url];
                      const status = entry?.status ?? "none";
                      return (
                        <li key={url} className="flex items-center gap-2 text-xs">
                          <span
                            className={`inline-block h-2 w-2 rounded-full shrink-0 ${
                              status === "ok"
                                ? "bg-emerald-500"
                                : status === "fail"
                                  ? "bg-rose-500"
                                  : "bg-zinc-300 dark:bg-zinc-600"
                            }`}
                          />
                          <span className="font-mono text-zinc-700 dark:text-zinc-300 truncate">{url}</span>
                          <span className="ml-auto shrink-0 text-zinc-400">
                            {status === "ok"
                              ? `${t("upstreamProxyStatusOk")} · ${entry.latencyMs}ms`
                              : status === "fail"
                                ? `${t("upstreamProxyStatusFail")} · ${entry.failCount}${t("upstreamProxyFailCountSuffix")}`
                                : t("upstreamProxyStatusNone")}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            <Button variant="primary" size="sm" onClick={save} loading={saving} icon={<Save size={14} />}>
              {t("common:save")}
            </Button>
          </div>
        </ProCard>
      </PageContainer>
    </AdminLayout>
  );
}