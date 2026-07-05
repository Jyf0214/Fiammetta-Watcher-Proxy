"use client";

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    console.error("[App Error]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="text-center">
        <h2 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
          {t("common.error")}
        </h2>
        <p className="text-zinc-500 dark:text-zinc-400 mb-4">
          {t("common.network_error")}
        </p>
        {error.digest && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-4">
            {t("common.error")}: {error.digest}
          </p>
        )}
        <button
          onClick={reset}
          className="px-4 py-2 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-xl hover:opacity-90 transition-opacity"
        >
          {t("common.refresh") || "重试"}
        </button>
      </div>
    </div>
  );
}
