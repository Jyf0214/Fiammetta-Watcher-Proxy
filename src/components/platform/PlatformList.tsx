"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { Input } from "antd";
import { Plus, Search, ChevronDown, Cloud, WalletCards, LayoutGrid, ShieldOff, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { BrandIcon, BRAND_MAP } from "@/components/platform/BrandIcon";
import { PresetIcon, PRESET_ICON_MAP } from "@/components/platform/PresetIcon";
import { PresetPickerModal } from "@/components/platform/PresetPickerModal";
import { cn } from "@/lib/ui";

/** 平台数据接口（与 API /api/admin/platforms 返回结构一致） */
export interface Platform {
  id: string;
  name: string;
  baseUrl: string;
  apiKeys: string;
  type: string;
  presetId?: string | null;
  enabled: boolean;
  priority: number;
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  forwardHeaders: string;
  injectStreamOptions?: boolean;
  reuseUserAgent?: boolean;
  customUserAgent?: string | null;
  extraHeaders?: string | null;
  status: string;
  failCount?: number;
  cooldownEnd?: number | null;
  keyStatuses?: Record<string, { status: string; expireAt: number | null }>;
}

/** 品牌图标 — 优先使用品牌 SVG 图标库，未匹配时回退到色块 + 首字母 */
const FALLBACK_BRAND: { box: string; text: string } = {
  box: "bg-zinc-100 dark:bg-zinc-800",
  text: "text-zinc-400 dark:text-zinc-500",
};

/** 品牌图标 — 预设来源优先显示预设图标，其次品牌 type 图标，未匹配时回退到色块 + 首字母 */
export function BrandAvatar({
  name,
  type,
  presetId,
  size = "md",
}: {
  name: string;
  type: string;
  presetId?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  const px = size === "lg" ? 48 : size === "sm" ? 22 : 32;
  const initial = name.trim().slice(0, 2).toUpperCase() || "?";
  const box =
    size === "lg" ? "w-12 h-12 rounded-2xl text-base" : size === "sm" ? "w-8 h-8 rounded-lg text-xs" : "w-10 h-10 rounded-lg text-sm";

  if (presetId && PRESET_ICON_MAP[presetId]) {
    return <PresetIcon presetId={presetId} size={px} />;
  }
  if (BRAND_MAP[type]) {
    return <BrandIcon type={type} size={px} />;
  }

  return (
    <div className={cn("shrink-0 flex items-center justify-center font-bold", box, FALLBACK_BRAND.box, FALLBACK_BRAND.text)}>
      {initial}
    </div>
  );
}

/** 状态圆点 — 8px 纯色：停用灰 / 健康绿 / 降级橙 / 异常红 */
export function StatusDot({ status, enabled }: { status: string; enabled: boolean }) {
  if (!enabled) {
    return <span className="w-2 h-2 rounded-full bg-zinc-300 dark:bg-zinc-600 shrink-0" />;
  }
  const color =
    status === "healthy" ? "bg-emerald-500" : status === "degraded" ? "bg-orange-400" : "bg-red-500";
  return <span className={cn("w-2 h-2 rounded-full shrink-0", color)} />;
}

/** 单个列表行 — 图标 + 名称 + 密钥状态徽标 + 状态点，整行点击进入独立路由 */
function PlatformRow({
  platform,
  active,
  onClick,
}: {
  platform: Platform;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation("platform");
  // 密钥实时状态徽标：统计该平台 429 封禁/降级中的密钥数（keyStatuses 键为指纹）
  const keyStatusCounts = useMemo(() => {
    const statuses = platform.keyStatuses ?? {};
    let banned = 0;
    let deprioritized = 0;
    for (const value of Object.values(statuses)) {
      if (value?.status === "banned") banned++;
      else if (value?.status === "deprioritized") deprioritized++;
    }
    return { banned, deprioritized };
  }, [platform.keyStatuses]);
  const hasKeyStatus = keyStatusCounts.banned > 0 || keyStatusCounts.deprioritized > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors",
        active
          ? "bg-zinc-100 dark:bg-zinc-800"
          : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
      )}
    >
      <BrandAvatar name={platform.name} type={platform.type} presetId={platform.presetId} size="sm" />
      <span className={cn(
        "flex-1 min-w-0 text-sm truncate",
        active ? "text-zinc-900 dark:text-zinc-100 font-medium" : "text-zinc-700 dark:text-zinc-300"
      )}>
        {platform.name}
      </span>
      {hasKeyStatus && (
        <span
          className="shrink-0 flex items-center gap-1"
          title={t("keyStatusTip")}
        >
          {keyStatusCounts.banned > 0 && (
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-900/30">
              <ShieldOff size={10} className="inline" />
              {t("keyStatusBanned")}
              {keyStatusCounts.banned > 1 ? ` ${keyStatusCounts.banned}` : ""}
            </span>
          )}
          {keyStatusCounts.deprioritized > 0 && (
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-amber-600 bg-amber-50 dark:text-amber-400 dark:bg-amber-900/30">
              <ShieldCheck size={10} className="inline" />
              {t("keyStatusDeprioritized")}
              {keyStatusCounts.deprioritized > 1 ? ` ${keyStatusCounts.deprioritized}` : ""}
            </span>
          )}
        </span>
      )}
      <StatusDot status={platform.status} enabled={platform.enabled} />
    </button>
  );
}

interface PlatformListProps {
  platforms: Platform[];
  loading?: boolean;
  /** 当前选中的平台 id（详情页桌面栏高亮用） */
  activeId?: string;
  className?: string;
}

/**
 * 平台列表 — 顶部搜索+新建工具条 + 全部/已启用/已禁用分组折叠行列表
 * 整行点击跳转独立路由 /admin/platforms/[id]
 */
export function PlatformList({
  platforms,
  loading = false,
  activeId,
  className,
}: PlatformListProps) {
  const { t } = useTranslation("platform");
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [items, setItems] = useState<Platform[]>(platforms);
  const [prevPlatforms, setPrevPlatforms] = useState(platforms);
  const [searchText, setSearchText] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    enabled: false,
    disabled: false,
  });

  // 外部数据变化时同步本地状态（渲染期调整，避免 effect 内同步 setState）
  if (prevPlatforms !== platforms) {
    setPrevPlatforms(platforms);
    setItems(platforms);
  }

  // 搜索时强制展开所有分组
  const searching = searchText.trim() !== "";

  const { enabled, disabled } = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    const list = q
      ? items.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.type.toLowerCase().includes(q) ||
            p.baseUrl.toLowerCase().includes(q)
        )
      : items;
    return {
      enabled: list.filter((p) => p.enabled),
      disabled: list.filter((p) => !p.enabled),
    };
  }, [items, searchText]);

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const goPlatform = (id: string) => router.push(`/admin/platforms/${id}`);
  const goPresets = () => router.push("/admin/platforms/presets");

  /** 分组折叠列表 */
  const renderGroup = (key: "enabled" | "disabled", label: string, items: Platform[]) => {
    if (items.length === 0) return null;
    const isCollapsed = collapsed[key] && !searching;
    return (
      <div>
        <button
          type="button"
          onClick={() => toggleGroup(key)}
          className="w-full flex items-center gap-1.5 px-2 py-2 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
        >
          <ChevronDown
            size={12}
            className={cn(
              "text-zinc-400 transition-transform duration-200 shrink-0",
              isCollapsed && "-rotate-90"
            )}
          />
          <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
            {label}
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
            {items.length}
          </span>
        </button>
        {!isCollapsed && (
          <div className="flex flex-col gap-0.5 px-1.5 pb-2.5">
            {items.map((p) => (
              <PlatformRow
                key={p.id}
                platform={p}
                active={activeId === p.id}
                onClick={() => goPlatform(p.id)}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={cn("flex flex-col bg-white dark:bg-zinc-900", className)}>
      {/* 工具条：搜索 + 预设入口 + 新建 */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-100 dark:border-zinc-800">
        <Input
          prefix={<Search size={14} className="text-zinc-400" />}
          placeholder={t("searchPlaceholder")}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          size="small"
          className="flex-1"
        />
        <button
          type="button"
          onClick={goPresets}
          className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition-colors"
          title={t("presets")}
          aria-label={t("presets")}
        >
          <LayoutGrid size={18} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition-colors"
          title={t("createPlatform")}
          aria-label={t("createPlatform")}
        >
          <Plus size={18} strokeWidth={1.5} />
        </button>
      </div>

      {/* 新建选择器：从预设选择或手动创建 */}
      <PresetPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
      />

      {/* 列表区 */}
      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-zinc-300 dark:text-zinc-600">
          <Cloud size={36} className="animate-pulse" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Cloud className="w-10 h-10" />}
          title={t("noPlatforms")}
          action={
            <Button variant="primary" size="sm" onClick={() => setPickerOpen(true)} icon={<Plus size={14} />}>
              {t("createPlatform")}
            </Button>
          }
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-2.5">
          {enabled.length === 0 && disabled.length === 0 ? (
            <EmptyState title={t("searchNoResult")} />
          ) : (
            <>
              {/* "全部"行：点击回到列表页全量视图 */}
              <button
                type="button"
                onClick={() => router.push("/admin/platforms")}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors",
                  !activeId
                    ? "bg-zinc-100 dark:bg-zinc-800"
                    : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                )}
              >
                <span className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
                  <WalletCards size={16} strokeWidth={1.5} />
                </span>
                <span className={cn(
                  "flex-1 min-w-0 text-sm truncate",
                  !activeId
                    ? "text-zinc-900 dark:text-zinc-100 font-medium"
                    : "text-zinc-700 dark:text-zinc-300"
                )}>
                  {t("groupAll")}
                </span>
              </button>
              {renderGroup("enabled", t("groupEnabled"), enabled)}
              {renderGroup("disabled", t("groupDisabled"), disabled)}
            </>
          )}
        </div>
      )}
    </div>
  );
}
