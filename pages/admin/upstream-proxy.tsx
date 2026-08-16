import { useState, useEffect } from "react";
import { Input, Select, message } from "antd";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { AsyncBoundary } from "@/components/ui/AsyncBoundary";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { Globe, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import AdminLayout from "@/components/AdminLayout";

/** 与 src/lib/upstream-proxy.ts 的常量保持一致（前端不直接 import，避免引入服务端依赖） */
const CONFIG_KEY = "system:upstream_proxy";
const POOL_KEY = "system:upstream_proxy_pool";
const HEALTH_KEY = "system:upstream_proxy_health";
const DEFAULT_CHECK_URL = "https://cp.cloudflare.com/generate_204";
/** 旧版配置（无 groups 字段）解析时补的组名，与后端「单组」语义等价 */
const LEGACY_GROUP_NAME = "default";

interface ProxyHealthEntry {
  status: "ok" | "fail";
  latencyMs: number;
  /** unix 秒 */
  checkedAt: number;
  failCount: number;
}
type ProxyHealthMap = Record<string, ProxyHealthEntry>;

interface ParsedGroup {
  name: string;
  sourceUrl: string;
  urls: string[];
}
interface ParsedConfig {
  groups: ParsedGroup[];
  platformIds: string[];
  platformGroup: Record<string, string>;
  healthCheckUrl?: string;
}

interface GroupFormState {
  id: string;
  name: string;
  sourceUrl: string;
  urlsText: string;
  boundPlatformIds: string[];
}

/** 解析代理配置（兼容旧版纯 URL 字符串 / {urls,...} / 新版 groups，与后端 parseProxyConfig 对齐） */
function parseProxyConfig(raw: string | undefined): ParsedConfig {
  if (!raw) return { groups: [], platformIds: [], platformGroup: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  if (typeof parsed === "string") {
    return { groups: [{ name: LEGACY_GROUP_NAME, sourceUrl: "", urls: [parsed] }], platformIds: [], platformGroup: {} };
  }
  if (Array.isArray(parsed)) {
    return {
      groups: [{ name: LEGACY_GROUP_NAME, sourceUrl: "", urls: parsed.filter((u): u is string => typeof u === "string") }],
      platformIds: [],
      platformGroup: {},
    };
  }
  if (!parsed || typeof parsed !== "object") return { groups: [], platformIds: [], platformGroup: {} };

  const obj = parsed as Record<string, unknown>;
  const groups: ParsedGroup[] = (Array.isArray(obj.groups) ? obj.groups : [])
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object" && !Array.isArray(g))
    .map((g) => ({
      name: typeof g.name === "string" ? g.name.trim() : "",
      sourceUrl: typeof g.sourceUrl === "string" ? g.sourceUrl.trim() : "",
      urls: Array.isArray(g.urls) ? g.urls.filter((u): u is string => typeof u === "string") : [],
    }))
    .filter((g) => g.name.length > 0);

  // 旧版字段（顶层 urls）兼容：无 groups 时视为单组
  const legacyUrls = Array.isArray(obj.urls) ? obj.urls.filter((u): u is string => typeof u === "string") : [];
  if (groups.length === 0 && legacyUrls.length > 0) {
    groups.push({ name: LEGACY_GROUP_NAME, sourceUrl: "", urls: legacyUrls });
  }

  const platformIds = Array.isArray(obj.platformIds)
    ? obj.platformIds.filter((p): p is string => typeof p === "string")
    : [];
  const platformGroup: Record<string, string> = {};
  if (obj.platformGroup && typeof obj.platformGroup === "object" && !Array.isArray(obj.platformGroup)) {
    for (const [pid, groupName] of Object.entries(obj.platformGroup as Record<string, unknown>)) {
      if (typeof groupName === "string") platformGroup[pid] = groupName;
    }
  }
  const healthCheckUrl = typeof obj.healthCheckUrl === "string" ? obj.healthCheckUrl : undefined;
  return { groups, platformIds, platformGroup, healthCheckUrl };
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

/** 解析拉取结果（{ groupName: [url] }，容忍脏数据） */
function parsePoolMap(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, string[]> = {};
    for (const [groupName, urls] of Object.entries(parsed)) {
      if (Array.isArray(urls)) {
        map[groupName] = urls.filter((u): u is string => typeof u === "string");
      }
    }
    return map;
  } catch {
    return {};
  }
}

/** 手动代理文本 → 地址数组（按行拆分、去空去重） */
function parseUrlsText(text: string): string[] {
  return [...new Set(text.split("\n").map((s) => s.trim()).filter(Boolean))];
}

/** 展示用规范化：裸 host:port 补 http://，与后端 normalizeProxyLine 写入健康表的键对齐 */
function normalizeProxyUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? u : `http://${u}`;
}

/** 单行代理地址是否合法（与后端 normalizeProxyLine 语义一致）：带协议头的必须 http(s)，
 *  无协议头视为裸 host:port 自动补 http://；解析失败（无 host、端口非法等）拒绝 */
function isProxyLineValid(line: string): boolean {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(line);
  if (hasScheme && !/^https?:\/\//i.test(line)) return false;
  try {
    const parsed = new URL(hasScheme ? line : `http://${line}`);
    return /^https?:$/.test(parsed.protocol) && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 组内全部候选地址（拉取结果 ∪ 手动代理，规范化 + 去重，供展示与健康查询共用） */
function collectGroupUrls(poolUrls: string[], manualUrls: string[]): string[] {
  return [...new Set([...poolUrls, ...manualUrls].map(normalizeProxyUrl))];
}

export default function UpstreamProxyPage() {
  const { t } = useTranslation("system");
  const [groups, setGroups] = useState<GroupFormState[]>([]);
  const [platformIds, setPlatformIds] = useState<string[]>([]);
  const [checkUrl, setCheckUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pulling, setPulling] = useState(false);
  const { data: config, error, isLoading, mutate } = useApi<Record<string, string>>("/api/admin/config");
  const { data: platforms } = useApi<{ id: string; name: string }[]>("/api/admin/platforms");

  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("common:error"));
    }
  }, [error, t]);

  // 首次加载完成/服务器配置值变化时回填表单（渲染期 state 同步 prev 值比较，
  // 避免 effect 内 setState 与渲染期读 ref）。
  // 用户编辑中 config 引用因 SWR 重新验证而变化但值未变 → 不回填，不覆盖
  // 未保存的编辑；保存后 mutate 的 config 值即用户输入值，回填无副作用；
  // 其他管理员修改了配置（值真变）→ 回填同步最新值
  const [prevConfigValue, setPrevConfigValue] = useState<string | undefined>(undefined);
  if (config && prevConfigValue !== config[CONFIG_KEY]) {
    setPrevConfigValue(config[CONFIG_KEY]);
    const parsed = parseProxyConfig(config[CONFIG_KEY]);
    setGroups(
      parsed.groups.map((g) => ({
        id: crypto.randomUUID(),
        name: g.name,
        sourceUrl: g.sourceUrl,
        urlsText: g.urls.join("\n"),
        boundPlatformIds: Object.entries(parsed.platformGroup)
          .filter(([, groupName]) => groupName === g.name)
          .map(([pid]) => pid),
      }))
    );
    setPlatformIds(parsed.platformIds);
    setCheckUrl(parsed.healthCheckUrl ?? "");
  }

  const deployPlatform = process.env.NEXT_PUBLIC_DEPLOY_PLATFORM || "";
  const isDocker = deployPlatform === "docker";

  const healthMap = parseHealthMap(config?.[HEALTH_KEY]);
  const poolMap = parsePoolMap(config?.[POOL_KEY]);

  /** 兼容后端两种错误形状：{ error: "msg" } 或 { error: { message } } */
  const errMsg = (data: Record<string, any>): string =>
    typeof data.error === "string" ? data.error : data.error?.message ?? t("common:error");

  /** 表单 → 配置 JSON 字符串（全空返回 "{}"；供保存与「已保存一致性」校验共用） */
  const buildConfigJson = (): string | null => {
    const trimmed = groups
      .map((g) => ({
        name: g.name.trim(),
        sourceUrl: g.sourceUrl.trim(),
        urls: parseUrlsText(g.urlsText),
        boundPlatformIds: [...new Set(g.boundPlatformIds)],
      }))
      .filter(
        (g) => g.name.length > 0 || g.sourceUrl.length > 0 || g.urls.length > 0 || g.boundPlatformIds.length > 0
      );
    if (trimmed.length === 0) return "{}";

    // 校验组名：必填且唯一
    const names = trimmed.map((g) => g.name);
    if (names.some((n) => !n)) {
      message.error(t("upstreamProxyGroupNameRequired"));
      return null;
    }
    if (new Set(names).size !== names.length) {
      message.error(t("upstreamProxyGroupNameDup"));
      return null;
    }
    // 校验拉取地址与手动代理
    for (const g of trimmed) {
      if (g.sourceUrl && !/^https?:\/\//i.test(g.sourceUrl)) {
        message.error(t("upstreamProxyInvalidSourceUrl"));
        return null;
      }
      if (g.urls.some((u) => !isProxyLineValid(u))) {
        message.error(t("upstreamProxyInvalidUrls"));
        return null;
      }
    }

    const platformGroup: Record<string, string> = {};
    for (const g of trimmed) {
      for (const pid of [...new Set(g.boundPlatformIds)]) platformGroup[pid] = g.name;
    }
    const checkUrlTrimmed = checkUrl.trim();
    if (checkUrlTrimmed && !/^https?:\/\//i.test(checkUrlTrimmed)) {
      message.error(t("upstreamProxyInvalidUrls"));
      return null;
    }
    return JSON.stringify({
      groups: trimmed.map((g) => ({
        name: g.name,
        ...(g.sourceUrl ? { sourceUrl: g.sourceUrl } : {}),
        ...(g.urls.length > 0 ? { urls: g.urls } : {}),
      })),
      platformIds,
      platformGroup,
      healthCheckUrl: checkUrlTrimmed || DEFAULT_CHECK_URL,
    });
  };

  const save = async () => {
    const value = buildConfigJson();
    if (value === null) return;
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
        message.error(errMsg(data));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setSaving(false);
    }
  };

  /** 手动触发拉取/检查前确认表单与已保存配置一致，避免结果与页面显示对不上 */
  const ensureSaved = (): boolean => {
    const saved = config?.[CONFIG_KEY];
    const current = buildConfigJson();
    if (current === null || current !== saved) {
      message.warning(t("upstreamProxySaveFirst"));
      return false;
    }
    return true;
  };

  const pullNow = async () => {
    if (!ensureSaved()) return;
    setPulling(true);
    try {
      const res = await fetch("/api/admin/upstream-proxy/pull", { method: "POST" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        mutate();
        const results = (data.data?.results ?? {}) as Record<string, { error?: string }>;
        const failed = Object.values(results).filter((r) => r?.error);
        if (Object.keys(results).length > 0 && failed.length === Object.keys(results).length) {
          message.error(t("upstreamProxyPullFailed"));
        } else if (failed.length > 0) {
          message.warning(t("upstreamProxyPullPartial"));
        } else {
          message.success(t("upstreamProxyPulled"));
        }
      } else {
        message.error(errMsg(data));
      }
    } catch {
      message.error(t("common:error"));
    } finally {
      setPulling(false);
    }
  };

  const checkNow = async () => {
    if (!ensureSaved()) return;
    setChecking(true);
    try {
      const res = await fetch("/api/admin/upstream-proxy/health", { method: "POST" });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        mutate();
        message.success(t("upstreamProxyHealthDone"));
      } else {
        message.error(errMsg(data));
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

  const updateGroup = (index: number, patch: Partial<GroupFormState>) => {
    setGroups((prev) => prev.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  };
  const addGroup = () => {
    setGroups((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name: "", sourceUrl: "", urlsText: "", boundPlatformIds: [] },
    ]);
  };
  const removeGroup = (index: number) => {
    setGroups((prev) => prev.filter((_, i) => i !== index));
  };

  const platformOptions = (platforms ?? []).map((p) => ({ label: p.name, value: p.id }));

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
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                {t("upstreamProxyGroupsLabel")}
              </label>
              <div className="space-y-3">
                {groups.map((g, idx) => {
                  const groupUrls = collectGroupUrls(poolMap[g.name] ?? [], parseUrlsText(g.urlsText));
                  return (
                    <div
                      key={g.id}
                      className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 space-y-3"
                    >
                      <div className="flex items-center gap-2">
                        <Input
                          value={g.name}
                          onChange={(e) => updateGroup(idx, { name: e.target.value })}
                          placeholder={t("upstreamProxyGroupNamePlaceholder")}
                          className="!w-40"
                        />
                        <Input
                          value={g.sourceUrl}
                          onChange={(e) => updateGroup(idx, { sourceUrl: e.target.value })}
                          placeholder={t("upstreamProxySourceUrlPlaceholder")}
                          allowClear
                        />
                        <Button
                          variant="dangerGhost"
                          size="sm"
                          onClick={() => removeGroup(idx)}
                          icon={<Trash2 size={14} />}
                        >
                          {t("upstreamProxyRemoveGroup")}
                        </Button>
                      </div>
                      <p className="text-xs text-zinc-400 -mt-1">{t("upstreamProxySourceUrlHelp")}</p>

                      <div>
                        <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                          {t("upstreamProxyManualUrlsLabel")}
                        </label>
                        <Input.TextArea
                          value={g.urlsText}
                          onChange={(e) => updateGroup(idx, { urlsText: e.target.value })}
                          placeholder={"127.0.0.1:7890\nhttp://127.0.0.1:7891"}
                          rows={2}
                          allowClear
                        />
                        <p className="text-xs text-zinc-400 mt-1">{t("upstreamProxyManualUrlsHelp")}</p>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                          {t("upstreamProxyGroupBoundPlatforms")}
                        </label>
                        <Select
                          mode="multiple"
                          value={g.boundPlatformIds}
                          onChange={(v: string[]) => updateGroup(idx, { boundPlatformIds: v })}
                          options={platformOptions}
                          placeholder={t("upstreamProxyGroupBoundPlatformsPlaceholder")}
                          allowClear
                          className="w-full"
                          maxTagCount={3}
                        />
                        <p className="text-xs text-zinc-400 mt-1">
                          {t("upstreamProxyGroupBoundPlatformsHelp")}
                        </p>
                      </div>

                      <div className="rounded-md bg-zinc-50 dark:bg-zinc-900/40 p-2">
                        {groupUrls.length === 0 ? (
                          <p className="text-xs text-zinc-400">{t("upstreamProxyGroupEmpty")}</p>
                        ) : (
                          <ul className="space-y-1">
                            {groupUrls.map((url) => {
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
                                  <span className="font-mono text-zinc-700 dark:text-zinc-300 truncate">
                                    {url}
                                  </span>
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
                    </div>
                  );
                })}
                <Button variant="secondary" size="sm" onClick={addGroup} icon={<Plus size={14} />}>
                  {t("upstreamProxyAddGroup")}
                </Button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                {t("upstreamProxyPlatformsLabel")}
              </label>
              <Select
                mode="multiple"
                value={platformIds}
                onChange={(v: string[]) => setPlatformIds(v)}
                options={platformOptions}
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
                  <div className="flex items-center gap-2">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={pullNow}
                      loading={pulling}
                      icon={<RefreshCw size={14} />}
                      disabled={groups.length === 0}
                    >
                      {t("upstreamProxyPullNow")}
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={checkNow}
                      loading={checking}
                      icon={<RefreshCw size={14} />}
                      disabled={groups.length === 0}
                    >
                      {t("upstreamProxyCheckNow")}
                    </Button>
                  </div>
                </div>
                {groups.length === 0 ? (
                  <p className="text-xs text-zinc-400">{t("upstreamProxyHealthEmpty")}</p>
                ) : (
                  <ul className="space-y-1.5">
                    {groups.flatMap((g) => {
                      const groupUrls = collectGroupUrls(poolMap[g.name] ?? [], parseUrlsText(g.urlsText));
                      return groupUrls.map((url) => {
                        const entry = healthMap[url];
                        const status = entry?.status ?? "none";
                        return (
                          <li key={`${g.name}:${url}`} className="flex items-center gap-2 text-xs">
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
                      });
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