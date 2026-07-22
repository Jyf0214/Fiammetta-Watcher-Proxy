"use client";

import { useEffect, useState } from "react";

// 修复：尝试使用 i18n，如果不可用则回退到硬编码文本（global-error 在 app layout 外渲染）
function useI18nFallback() {
  const [t, setT] = useState<(key: string, fallback?: string) => string>(
    (_key, fallback) => fallback ?? _key
  );

  useEffect(() => {
    try {
      // 动态导入 i18n，避免在全局错误边界中静态依赖
      import("@/lib/i18n").then(({ default: i18nInstance }) => {
        // 修复：使用正确的 i18n.t() 调用方式
        setT(() => (key: string, fallback?: string) =>
          fallback !== undefined ? i18nInstance.t(key, fallback) : i18nInstance.t(key)
        );
      }).catch(() => {
        // i18n 不可用时保持回退翻译
      });
    } catch {
      // 静默失败，使用回退翻译
    }
  }, []);

  return t;
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useI18nFallback();

  useEffect(() => {
    console.error("[Global Error]", error);
  }, [error]);

  return (
    <html>
      <body>
        <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", backgroundColor: "#fafafa" }}>
          <div style={{ textAlign: "center" }}>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.5rem", color: "#18181b" }}>
              {t("common.error", "系统错误")}
            </h2>
            <p style={{ color: "#6b7280", marginBottom: "1rem" }}>
              {t("common.network_error", "系统发生了严重错误，请刷新页面重试。")}
            </p>
            <button
              onClick={reset}
              style={{
                padding: "0.5rem 1rem",
                backgroundColor: "#18181b",
                color: "white",
                border: "none",
                borderRadius: "0.75rem",
                cursor: "pointer",
                transition: "opacity 0.2s",
              }}
              onMouseOver={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.9"; }}
              onMouseOut={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
            >
              {t("common.refresh", "重试")}
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
