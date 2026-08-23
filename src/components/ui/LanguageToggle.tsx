"use client";

import { useEffect } from "react";
import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/lib/i18n";

/**
 * 语言切换按钮 — 点击在中/英文间切换
 */
export function LanguageToggle() {
  const { t } = useTranslation("common");
  const currentLang = i18n.language?.startsWith("en") ? "en" : "zh";
  const nextLang = currentLang === "zh" ? "en" : "zh";
  const label = currentLang === "zh" ? t("langEn") : t("langZh");

  // html lang 属性跟随界面语言（en/zh-CN）；挂载时同步一次，
  // 之后随 i18n.language 变化更新（useTranslation 订阅 languageChanged 触发重渲染）。
  // SSR 初始值 zh-CN 由 _document 提供，此处仅负责客户端切换后的同步。
  useEffect(() => {
    document.documentElement.lang = currentLang === "en" ? "en" : "zh-CN";
  }, [currentLang]);

  return (
    <button
      onClick={() => i18n.changeLanguage(nextLang)}
      className="flex items-center gap-1.5 px-2 py-2 rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
      aria-label={t("language")}
      title={label}
    >
      <Languages className="w-[18px] h-[18px]" />
      <span className="text-xs font-medium hidden sm:inline">{label}</span>
    </button>
  );
}

export default LanguageToggle;
