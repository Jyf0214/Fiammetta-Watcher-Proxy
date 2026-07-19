"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { toast } from "@lobehub/ui";
import { message } from "antd";
import AuthLayout from "@/components/auth/AuthLayout";
import AuthCard from "@/components/auth/AuthCard";
import { Mail, Lock, ChevronRight, ArrowLeft, KeyRound, Copy, Check } from "lucide-react";
import { LoadingSpinner } from "@/components/ui/Button/LoadingSpinner";
import "@/lib/i18n";

export default function AdminLoginPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"username" | "password">("username");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [copied, setCopied] = useState(false);

  // 复制错误信息到剪贴板
  const handleCopyError = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 修复：复制失败时提供反馈
      try {
        // 回退方案：使用 textarea 选择复制
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // 最终回退：显示提示信息
        toast.error(t("common.copy_failed") || "复制失败，请手动复制");
      }
    }
  };

  // 自动聚焦
  useEffect(() => {
    const el = document.getElementById(
      step === "username" ? "login-username" : "login-password"
    );
    el?.focus();
  }, [step]);

  const handleSubmitUsername = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    if (!username.trim()) {
      setError(t("auth.username") + t("validation.field_required"));
      return;
    }
    setStep("password");
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!password) {
      setError(t("auth.password") + t("validation.field_required"));
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });

      const data = await res.json();

      if (data.success) {
        setSuccess(data.message || t("auth.login_success"));
        const hide = message.loading(t("auth.redirecting") || "正在跳转...", 1.5);
        setTimeout(() => {
          hide();
          router.push("/admin");
        }, 800);
      } else {
        setError(data.error || t("auth.login_failed"));
      }
    } catch (err) {
      const msg = err instanceof TypeError && err.message.includes("fetch")
        ? t("common.network_error")
        : t("auth.login_failed");
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    setStep("username");
    setPassword("");
    setError("");
    setSuccess("");
  };

  const handleForgotPassword = async () => {
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/auth/reset-password", {
        method: "POST",
      });
      const data = await res.json();
      if (data.success) {
        setSuccess(data.message || t("auth.reset_password_submitted"));
      } else {
        setError(data.error || t("auth.reset_password_failed"));
      }
    } catch {
      setError(t("common.network_error"));
    } finally {
      setLoading(false);
    }
  };

  const inputStyle =
    "w-full px-4 py-3.5 text-base rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900 dark:focus:ring-zinc-100 focus:border-transparent transition-all";

  const btnPrimary =
    "w-full flex items-center justify-center gap-2 py-3.5 rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed text-base";

  const renderUsernameStep = () => (
    <AuthCard
      title={t("auth.welcome_back") || "欢迎回来"}
      subtitle={t("auth.login_subtitle") || "输入用户名继续"}
      footer={
        <div className="flex flex-col items-center gap-4 mt-4">
          <span className="text-xs text-zinc-400 dark:text-zinc-500">
            {t("auth.admin_only") || "仅限管理员登录"}
          </span>
        </div>
      }
    >
      <form onSubmit={handleSubmitUsername} className="flex flex-col gap-4">
        <div className="relative">
          <Mail
            size={16}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400"
          />
          <input
            id="login-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("auth.username")}
            className={inputStyle + " pl-11 pr-4"}
            autoComplete="username"
            autoFocus
          />
        </div>

        {error && (
          <div role="alert" className="flex items-start justify-between gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
            <span className="break-all">{error}</span>
            <button
              type="button"
              onClick={() => handleCopyError(error)}
              className="shrink-0 mt-0.5 p-1 rounded hover:bg-red-100 dark:hover:bg-red-800/30 transition-colors"
              aria-label="复制错误信息"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        )}

        {success && (
          <div role="alert" className="px-3 py-2 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-600 dark:text-green-400 text-sm">
            {success}
          </div>
        )}

        <button type="submit" className={btnPrimary} disabled={loading} aria-label={t("common.next")}>
          {loading ? (
            <LoadingSpinner />
          ) : (
            <>
              <ChevronRight size={18} />
              {t("common.next")}
            </>
          )}
        </button>
      </form>
    </AuthCard>
  );

  const renderPasswordStep = () => (
    <AuthCard
      title={t("auth.welcome_back") || "欢迎回来"}
      subtitle={t("auth.input_password") || "输入密码以登录"}
      footer={
        <div className="flex flex-col gap-3 mt-4">
          <button
            type="button"
            onClick={handleForgotPassword}
            disabled={loading}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-sm font-medium disabled:opacity-50"
            aria-label={t("auth.forgot_password")}
          >
            <KeyRound size={14} />
            {t("auth.forgot_password") || "忘记密码"}
          </button>
          <button
            type="button"
            onClick={handleBack}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-sm font-medium"
            aria-label={t("common.back")}
          >
            <ArrowLeft size={14} />
            {t("common.back")}
          </button>
        </div>
      }
    >
      <div className="text-base text-zinc-900 dark:text-zinc-100 font-medium mb-4">
        {username}
      </div>
      <form onSubmit={handleLogin} className="flex flex-col gap-4">
        <div className="relative">
          <Lock
            size={16}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400"
          />
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t("auth.password")}
            className={inputStyle + " pl-11 pr-4"}
            autoComplete="current-password"
            autoFocus
          />
        </div>

        {error && (
          <div role="alert" className="flex items-start justify-between gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
            <span className="break-all">{error}</span>
            <button
              type="button"
              onClick={() => handleCopyError(error)}
              className="shrink-0 mt-0.5 p-1 rounded hover:bg-red-100 dark:hover:bg-red-800/30 transition-colors"
              aria-label="复制错误信息"
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        )}

        {success && (
          <div role="alert" className="px-3 py-2 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-600 dark:text-green-400 text-sm">
            {success}
          </div>
        )}

        <button
          type="submit"
          className={btnPrimary}
          disabled={loading}
          aria-label={t("auth.login")}
        >
          {loading ? (
            <LoadingSpinner />
          ) : (
            <>
              <ChevronRight size={18} />
              {t("auth.login")}
            </>
          )}
        </button>
      </form>
    </AuthCard>
  );

  return (
    <AuthLayout>
      {step === "username" && renderUsernameStep()}
      {step === "password" && renderPasswordStep()}
    </AuthLayout>
  );
}
