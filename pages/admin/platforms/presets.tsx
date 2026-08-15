import { useMemo, useState } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { Input } from "antd";
import { ArrowLeft, Search, Layers, Plus } from "lucide-react";
import "@/lib/i18n";
import AdminLayout from "@/components/AdminLayout";
import { Button } from "@/components/ui/Button";
import { PRESET_PLATFORMS, type PlatformPreset } from "@/lib/presets";
import { PresetIcon } from "@/components/platform/PresetIcon";
import { PresetCreateModal } from "@/components/platform/PresetCreateModal";

/**
 * 预设平台发现页 — 卡片网格展示内置预设，一键创建平台与模型清单
 * 路由 /admin/platforms/presets
 */
export default function PresetPlatformsPage() {
  const { t } = useTranslation("platform");
  const router = useRouter();
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<PlatformPreset | null>(null);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    if (!q) return PRESET_PLATFORMS;
    return PRESET_PLATFORMS.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    );
  }, [keyword]);

  return (
    <AdminLayout>
      {/* 移动端返回条 */}
      <div className="lg:hidden sticky top-16 z-30 bg-white/95 dark:bg-zinc-900/95 backdrop-blur -mx-4 -mt-4 px-4 py-2.5 h-[52px] flex items-center justify-between border-b border-zinc-200/80 dark:border-zinc-800">
        <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
          <button
            onClick={() => router.push("/admin/platforms")}
            className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 shrink-0"
            aria-label={t("back")}
          >
            <ArrowLeft size={18} />
          </button>
          <span className="text-[15px] font-bold text-zinc-900 dark:text-zinc-100 truncate">
            {t("presets")}
          </span>
        </div>
      </div>

      <div className="flex-1 min-w-0 w-full max-w-4xl mx-auto pt-4 lg:pt-6 pb-10">
        {/* 页头（桌面端） */}
        <div className="hidden lg:flex items-center gap-2 mb-4">
          <button
            onClick={() => router.push("/admin/platforms")}
            className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
            aria-label={t("back")}
          >
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{t("presets")}</h1>
        </div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4 hidden lg:block">
          {t("presetsDesc")}
        </p>

        {/* 搜索 + 统计 */}
        <div className="flex items-center gap-2 mb-4">
          <Input
            prefix={<Search size={14} className="text-zinc-400" />}
            placeholder={t("searchPresets")}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            allowClear
            size="small"
            className="max-w-xs"
          />
          <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 shrink-0">
            {t("presetModelCount", { count: filtered.length })}
          </span>
        </div>

        {/* 卡片网格 */}
        {filtered.length === 0 ? (
          <div className="text-center text-sm text-zinc-400 py-16">{t("presetSearchNoResult")}</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((p) => (
              <div
                key={p.id}
                className="flex flex-col rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3.5 transition-colors hover:border-zinc-300 dark:hover:border-zinc-700"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <PresetIcon presetId={p.id} size={32} />
                  <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                    {p.name}
                  </span>
                </div>
                {p.description && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 line-clamp-2 min-h-[32px]">
                    {p.description}
                  </p>
                )}
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800">
                  <span className="flex items-center gap-1 text-[11px] text-zinc-400">
                    <Layers size={12} />
                    {t("presetModelCount", { count: p.models.length })}
                    {!p.baseUrl && (
                      <span className="ml-1 px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400">
                        {t("presetNoBaseUrl")}
                      </span>
                    )}
                  </span>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => setSelected(p)}
                    icon={<Plus size={14} />}
                  >
                    {t("presetCreate")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <PresetCreateModal
        preset={selected}
        onClose={() => setSelected(null)}
      />
    </AdminLayout>
  );
}