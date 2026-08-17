"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { Input } from "antd";
import { Plus, Search, Globe } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/ui";

/** 列表行数据（由列表页从配置/拉取池/健康表汇总） */
export interface ProxyGroupSummary {
  name: string;
  sourceUrl: string;
  /** 组内候选代理数 */
  proxyCount: number;
  /** 组内健康 ok 数 */
  okCount: number;
  /** 组内健康 fail 数 */
  failCount: number;
  /** 组启用开关（false 时行内徽标提示禁用） */
  enabled: boolean;
  /** 组请求可用率（0-1，经代理真实请求的 2xx 占比；undefined = 无请求数据） */
  availability?: number;
}

/** 可用率徽标颜色分级：≥90% 绿 / ≥50% 琥珀 / 其余红 */
function availabilityClass(availability: number): string {
  if (availability >= 0.9) return "text-emerald-600 dark:text-emerald-400";
  if (availability >= 0.5) return "text-amber-600 dark:text-amber-500";
  return "text-rose-500";
}

/** 组内健康状态圆点：有异常红 / 全部正常绿 / 未检查灰 */
function GroupHealthDot({ okCount, failCount, proxyCount }: ProxyGroupSummary) {
  const color =
    proxyCount === 0
      ? "bg-zinc-300 dark:bg-zinc-600"
      : failCount > 0
        ? "bg-rose-500"
        : okCount > 0
          ? "bg-emerald-500"
          : "bg-zinc-300 dark:bg-zinc-600";
  return <span className={cn("w-2 h-2 rounded-full shrink-0", color)} />;
}

/** 单个组行 — 头像 + 名称 + 订阅地址 + 代理数徽章 + 健康点，整行点击进入独立路由 */
function GroupRow({
  group,
  active,
  onClick,
}: {
  group: ProxyGroupSummary;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation("system");
  const initial = group.name.trim().slice(0, 2).toUpperCase() || "?";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left transition-colors",
        active ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
      )}
    >
      <span className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 text-xs font-bold">
        {initial}
      </span>
      <span className="flex-1 min-w-0">
        <span
          className={cn(
            "block text-sm truncate",
            active ? "text-zinc-900 dark:text-zinc-100 font-medium" : "text-zinc-700 dark:text-zinc-300"
          )}
        >
          {group.name}
          {!group.enabled && (
            <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400 align-middle">
              {t("upstreamProxyGroupDisabled")}
            </span>
          )}
        </span>
        <span className="block text-[11px] text-zinc-400 truncate font-mono">
          {group.sourceUrl || "—"}
        </span>
      </span>
      <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
        {group.proxyCount}
      </span>
      {group.availability !== undefined && (
        <span
          className={cn("shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-50 dark:bg-zinc-800/60 font-mono", availabilityClass(group.availability))}
          title={t("upstreamProxyAvailability")}
        >
          {Math.round(group.availability * 100)}%
        </span>
      )}
      <GroupHealthDot {...group} />
    </button>
  );
}

interface ProxyGroupListProps {
  groups: ProxyGroupSummary[];
  loading?: boolean;
  /** 当前选中的组名（详情页桌面栏高亮用） */
  activeName?: string;
  className?: string;
}

/**
 * 代理组列表 — 顶部搜索+新建工具条 + 紧凑行列表
 * 整行点击跳转独立路由 /admin/upstream-proxy/[组名]
 */
export function ProxyGroupList({ groups, loading = false, activeName, className }: ProxyGroupListProps) {
  const { t } = useTranslation("system");
  const router = useRouter();
  const [searchText, setSearchText] = useState("");

  const filtered = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) => g.name.toLowerCase().includes(q) || g.sourceUrl.toLowerCase().includes(q)
    );
  }, [groups, searchText]);

  return (
    <div className={cn("flex flex-col bg-white dark:bg-zinc-900", className)}>
      {/* 工具条：搜索 + 新建 */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-zinc-100 dark:border-zinc-800">
        <Input
          prefix={<Search size={14} className="text-zinc-400" />}
          placeholder={t("upstreamProxySearchGroups")}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          allowClear
          size="small"
          className="flex-1"
        />
        <button
          type="button"
          onClick={() => router.push("/admin/upstream-proxy/new")}
          className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 transition-colors"
          title={t("upstreamProxyNewGroup")}
          aria-label={t("upstreamProxyNewGroup")}
        >
          <Plus size={18} strokeWidth={1.5} />
        </button>
      </div>

      {/* 列表区 */}
      {loading && groups.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-zinc-300 dark:text-zinc-600">
          <Globe size={36} className="animate-pulse" />
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<Globe className="w-10 h-10" />}
          title={t("upstreamProxyNoGroups")}
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={() => router.push("/admin/upstream-proxy/new")}
              icon={<Plus size={14} />}
            >
              {t("upstreamProxyNewGroup")}
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState title={t("upstreamProxySearchNoResult")} />
      ) : (
        <div className="flex-1 overflow-y-auto p-2.5">
          <div className="flex flex-col gap-0.5">
            {filtered.map((g) => (
              <GroupRow
                key={g.name}
                group={g}
                active={activeName === g.name}
                onClick={() => router.push(`/admin/upstream-proxy/${encodeURIComponent(g.name)}`)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}