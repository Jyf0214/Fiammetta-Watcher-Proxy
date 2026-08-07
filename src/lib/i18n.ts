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
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
  });

export default i18n;
