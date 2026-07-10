"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { LogIn } from "lucide-react";
import { message } from "antd";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

export default function LoginPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 自动聚焦用户名输入框
  useEffect(() => {
    document.getElementById("username")?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (data.success) {
        message.success(t("auth.login_success"));
        // 登录成功后跳转到 /admin
        router.push("/admin");
      } else {
        setError(data.error || t("auth.login_failed"));
      }
    } catch {
      setError(t("common.network_error"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-900 dark:to-zinc-950">
      <div className="w-full max-w-sm mx-4">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center shadow-lg">
            <span className="text-2xl font-bold text-white dark:text-zinc-900">
              F
            </span>
          </div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Fiammetta Watcher
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400 mt-1">
            {t("admin.dashboard")}
          </p>
        </div>

        {/* 登录表单 */}
        <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-xl border border-zinc-200 dark:border-zinc-700 p-8">
          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
                {error}
              </div>
            )}

            <div>
              <label
                htmlFor="username"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
              >
                {t("auth.username")}
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-600 rounded-lg bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-500 focus:border-transparent transition-colors"
                autoComplete="username"
                required
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
              >
                {t("auth.password")}
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-zinc-200 dark:border-zinc-600 rounded-lg bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-500 focus:border-transparent transition-colors"
                autoComplete="current-password"
                required
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              variant="primary"
              disabled={loading}
              loading={loading}
            >
              <LogIn className="w-4 h-4 mr-2" />
              {loading ? t("common.loading") : t("auth.login")}
            </Button>
          </form>
        </div>

        <p className="text-center text-zinc-400 dark:text-zinc-500 text-xs mt-6">
          © {new Date().getFullYear()} Fiammetta Watcher
        </p>
      </div>
    </div>
  );
}
