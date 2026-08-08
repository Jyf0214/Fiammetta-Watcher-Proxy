"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { Input } from "antd";
import { Plus, Search, ChevronDown, Cloud, WalletCards } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/ui";

/** 平台数据接口（与 API /api/admin/platforms 返回结构一致） */
export interface Platform {
  id: string;
  name: string;
  baseUrl: string;
  apiKeys: string;
  type: string;
  enabled: boolean;
  priority: number;
  weight: number;
  rpmLimit: number | null;
  tpmLimit: number | null;
  forwardHeaders: string;
  status: string;
  failCount?: number;
  keyStatuses?: Record<string, { status: string; expireAt: number | null }>;
}

/** 品牌 → 色块映射（不引入外链 Logo，色块 + 首字母） */
const BRAND_STYLE: Record<string, { box: string; text: string }> = {
  openai: {
    box: "bg-zinc-900 dark:bg-zinc-100",
    text: "text-white dark:text-zinc-900",
  },
  azure: {
    box: "bg-blue-500",
    text: "text-white",
  },
  custom: {
    box: "bg-zinc-200 dark:bg-zinc-700",
    text: "text-zinc-500 dark:text-zinc-300",
  },
};

const DEFAULT_BRAND: { box: string; text: string } = {
  box: "bg-zinc-100 dark:bg-zinc-800",
  text: "text-zinc-400 dark:text-zinc-500",
};

/** 品牌图标 — 圆角方块 + 名称首字母 */
export function BrandAvatar({
  name,
  type,
  size = "md",
}: {
  name: string;
  type: string;
  size?: "sm" | "md" | "lg";
}) {
  const style = BRAND_STYLE[type] ?? DEFAULT_BRAND;
  const initial = name.trim().slice(0, 2).toUpperCase() || "?";
  const box =
    size === "lg" ? "w-12 h-12 rounded-2xl text-base" : size === "sm" ? "w-8 h-8 rounded-lg text-xs" : "w-10 h-10 rounded-lg text-sm";
  return (
    <div className={cn("shrink-0 flex items-center justify-center font-bold", box, style.box, style.text)}>
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

/** 单个列表行 — 图标 + 名称 + 状态点，整行点击进入独立路由（对照 ProviderMenu 的 NavItem 行） */
function PlatformRow({
  platform,
  active,
  onClick,
}: {
  platform: Platform;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors border-l-2",
        // 选中态用蓝色指示条 + 蓝调底色，与 hover 拉开档位；border-l-2 常驻避免选中行内容偏移 2px
        active
          ? "bg-blue-50 dark:bg-blue-900/20 border-blue-500 dark:border-blue-400"
          : "border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
      )}
    >
      <BrandAvatar name={platform.name} type={platform.type} size="sm" />
      <span className={cn(
        "flex-1 min-w-0 text-sm truncate",
        active ? "text-blue-700 dark:text-blue-300 font-medium" : "text-zinc-800 dark:text-zinc-200"
      )}>
        {platform.name}
      </span>
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
 * LobeChat 风格平台列表 — 顶部搜索+新建工具条 + 全部/已启用/已禁用分组折叠行列表
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
  const goCreate = () => router.push("/admin/platforms/new");

  /** 分组折叠列表（对照 ProviderMenu 的 Accordion 分组） */
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
      {/* 工具条：搜索 + 新建 */}
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
          onClick={goCreate}
          className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition-colors"
          title={t("createPlatform")}
          aria-label={t("createPlatform")}
        >
          <Plus size={18} strokeWidth={1.5} />
        </button>
      </div>

      {/* 列表区 */}
      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-zinc-300 dark:text-zinc-600">
          <Cloud size={36} className="animate-pulse" />
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-zinc-400">
          <Cloud size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t("noPlatforms")}</p>
          <Button variant="primary" size="sm" className="mt-4" onClick={goCreate} icon={<Plus size={14} />}>
            {t("createPlatform")}
          </Button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-2.5">
          {enabled.length === 0 && disabled.length === 0 ? (
            <div className="text-center py-12 text-zinc-400 text-sm">
              {t("searchNoResult")}
            </div>
          ) : (
            <>
              {/* “全部”行（对照 ProviderMenu 的 All 项）：点击回到列表页全量视图；选中态与平台行统一蓝色方案 */}
              <button
                type="button"
                onClick={() => router.push("/admin/platforms")}
                className={cn(
                  "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors border-l-2",
                  !activeId
                    ? "bg-blue-50 dark:bg-blue-900/20 border-blue-500 dark:border-blue-400"
                    : "border-transparent hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                )}
              >
                <span className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
                  <WalletCards size={16} strokeWidth={1.5} />
                </span>
                <span className={cn(
                  "flex-1 min-w-0 text-sm truncate",
                  !activeId
                    ? "text-blue-700 dark:text-blue-300 font-medium"
                    : "text-zinc-800 dark:text-zinc-200"
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
