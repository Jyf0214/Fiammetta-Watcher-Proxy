"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { Input } from "antd";
import { Plus, Search, ChevronDown, Cloud } from "lucide-react";
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

/** 单个列表行 — 整行点击进入独立路由 */
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
        "w-full flex items-center gap-3 px-4 py-3 text-left transition-colors",
        active
          ? "bg-zinc-100 dark:bg-zinc-800"
          : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
      )}
    >
      <BrandAvatar name={platform.name} type={platform.type} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
          {platform.name}
        </p>
        <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate font-mono">
          {platform.baseUrl}
        </p>
      </div>
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
 * LobeChat 风格平台列表 — 顶部搜索+新建工具条 + 已启用/未启用两组折叠列表
 * 整行点击跳转独立路由 /admin/platforms/[id]
 */
export function PlatformList({
  platforms,
  loading = false,
  activeId,
  className,
}: PlatformListProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const [searchText, setSearchText] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    enabled: false,
    disabled: false,
  });

  // 搜索时强制展开所有分组
  const searching = searchText.trim() !== "";

  const { enabled, disabled } = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    const list = q
      ? platforms.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            p.type.toLowerCase().includes(q) ||
            p.baseUrl.toLowerCase().includes(q)
        )
      : platforms;
    return {
      enabled: list.filter((p) => p.enabled),
      disabled: list.filter((p) => !p.enabled),
    };
  }, [platforms, searchText]);

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const goPlatform = (id: string) => router.push(`/admin/platforms/${id}`);
  const goCreate = () => router.push("/admin/platforms/new");

  const renderGroup = (key: "enabled" | "disabled", label: string, items: Platform[]) => {
    if (items.length === 0) return null;
    const isCollapsed = collapsed[key] && !searching;
    return (
      <div>
        <button
          type="button"
          onClick={() => toggleGroup(key)}
          className="w-full flex items-center gap-1.5 px-4 py-2.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
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
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70">
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
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
        <Input
          prefix={<Search size={14} className="text-zinc-400" />}
          placeholder={t("platform.search_placeholder")}
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
          title={t("platform.create_platform")}
          aria-label={t("platform.create_platform")}
        >
          <Plus size={18} strokeWidth={1.5} />
        </button>
      </div>

      {/* 列表区 */}
      {loading && platforms.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-zinc-300 dark:text-zinc-600">
          <Cloud size={36} className="animate-pulse" />
        </div>
      ) : platforms.length === 0 ? (
        <div className="text-center py-16 text-zinc-400">
          <Cloud size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t("platform.no_platforms")}</p>
          <Button variant="primary" size="sm" className="mt-4" onClick={goCreate} icon={<Plus size={14} />}>
            {t("platform.create_platform")}
          </Button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {enabled.length === 0 && disabled.length === 0 ? (
            <div className="text-center py-12 text-zinc-400 text-sm">
              {t("platform.search_no_result")}
            </div>
          ) : (
            <>
              {renderGroup("enabled", t("platform.group_enabled"), enabled)}
              {renderGroup("disabled", t("platform.group_disabled"), disabled)}
            </>
          )}
        </div>
      )}
    </div>
  );
}
