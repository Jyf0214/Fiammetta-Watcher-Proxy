import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import zh from "@/../messages/zh.json";
import en from "@/../messages/en.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // messages/*.json 顶层即命名空间（common/auth/admin/...）
    resources: {
      zh,
      en,
    },
    fallbackLng: "zh",
    interpolation: {
      escapeValue: false,
      prefix: "{",
      suffix: "}",
      // 未传参的插值块（如展示用 JSON 文本中的花括号）保留原文，避免被误插值
      skipOnVariables: true,
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
  });

export default i18n;
