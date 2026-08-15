"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { Modal, Input, Spin } from "antd";
import { Search } from "lucide-react";
import type { PlatformPreset } from "@/lib/presets";
import { PresetIcon } from "@/components/platform/PresetIcon";
import { PresetCreateModal } from "@/components/platform/PresetCreateModal";

interface PresetPickerModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 新建平台选择器 — 从预设列表选择后进入创建确认
 * 预设数据按需加载，不随列表页主 bundle 打包
 */
export function PresetPickerModal({ open, onClose }: PresetPickerModalProps) {
  const { t } = useTranslation("platform");
  const router = useRouter();
  const [presets, setPresets] = useState<PlatformPreset[] | null>(null);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<PlatformPreset | null>(null);

  // Modal 打开时按需加载预设数据
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    import("@/lib/presets").then((mod) => {
      if (!cancelled) setPresets(mod.PRESET_PLATFORMS);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const filtered = useMemo(() => {
    if (!presets) return [];
    const q = keyword.trim().toLowerCase();
    if (!q) return presets;
    return presets.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    );
  }, [presets, keyword]);

  const handleClose = () => {
    onClose();
    setSelected(null);
    setKeyword("");
  };

  return (
    <>
      <Modal
        open={open}
        title={t("presets")}
        onCancel={handleClose}
        footer={null}
        centered
        width={520}
        style={{ maxWidth: "90vw" }}
        destroyOnClose
      >
        <div className="flex items-center gap-2 pb-3">
          <Input
            prefix={<Search size={14} className="text-zinc-400" />}
            placeholder={t("searchPresets")}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            allowClear
            size="small"
          />
        </div>

        <div className="max-h-[50vh] overflow-y-auto -mx-4 px-4">
          {presets === null ? (
            <div className="flex items-center justify-center py-10">
              <Spin size="small" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center text-sm text-zinc-400 py-10">{t("presetSearchNoResult")}</div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {filtered.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelected(p)}
                  className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                >
                  <PresetIcon presetId={p.id} size={28} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-zinc-800 dark:text-zinc-200 truncate">{p.name}</span>
                    <span className="block text-[11px] text-zinc-400 truncate">{p.id}</span>
                  </span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 shrink-0">
                    {t("presetModelCount", { count: p.models.length })}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end pt-3 border-t border-zinc-100 dark:border-zinc-800 mt-3">
          <button
            type="button"
            onClick={() => {
              handleClose();
              router.push("/admin/platforms/new");
            }}
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
          >
            {t("presetManual")}
          </button>
        </div>
      </Modal>

      <PresetCreateModal
        preset={selected}
        onClose={() => setSelected(null)}
        onCreated={() => handleClose()}
      />
    </>
  );
}