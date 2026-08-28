import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/router";
import { useTranslation } from "react-i18next";
import { message } from "antd";
import AuthLayout from "@/components/auth/AuthLayout";
import AuthCard from "@/components/auth/AuthCard";
import { Mail, Lock, ChevronRight, ArrowLeft, Copy, Check } from "lucide-react";
import { LoadingSpinner } from "@/components/ui/Button/LoadingSpinner";
import "@/lib/i18n";

export default function AdminLoginPage() {
  const { t } = useTranslation("auth");
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"username" | "password">("username");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // 两步验证：服务端返回 need2fa 时展示验证码输入并在重试时携带
  const [totpCode, setTotpCode] = useState("");
  const [need2fa, setNeed2fa] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [copied, setCopied] = useState(false);
  /** 登录限流解锁时间戳（429 响应 resetAt），倒计时归零自动清除提示 */
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const [retryIn, setRetryIn] = useState(0);
  /** 登录成功后的跳转定时器（卸载时清理，防止组件卸载后仍触发路由跳转） */
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清理跳转定时器
  useEffect(() => {
    return () => {
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
    };
  }, []);

  // 已登录访问登录页：调 GET /api/admin/auth 验证 cookie 有效性，
  // 200 即视为已登录，跳转到 /admin（带 cookie 旧/失效则 401 留在登录页）。
  // 依赖 cookie 而非 localStorage 是因为登录态完全存在 HttpOnly cookie 里
  // （pages/api/admin/auth.ts setAuthCookie），前端无法读 HttpOnly，仅能
  // 走 /api/admin/auth 端到端验证。失败路径不展示错误——让登录表单自然呈现
  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/auth", { method: "GET" })
      .then(async (res): Promise<{ success?: boolean; data?: { username?: string } } | null> => {
        if (!res.ok) return null;
        return (await res.json()) as { success?: boolean; data?: { username?: string } };
      })
      .then((data) => {
        if (cancelled) return;
        if (data?.success && data?.data?.username) {
          router.replace("/admin");
        }
      })
      .catch(() => {
        // 网络/服务异常：静默忽略，留在登录页（不影响正常使用）
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  // 登录限流倒计时：每秒刷新剩余秒数，到期自动清除锁定提示
  useEffect(() => {
    if (lockUntil === null) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((lockUntil - Date.now()) / 1000));
      setRetryIn(remaining);
      if (remaining <= 0) {
        setLockUntil(null);
        setError("");
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [lockUntil]);

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
        message.error(t("common:copyFailed"));
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
      setError(t("username") + t("validation:required"));
      return;
    }
    setStep("password");
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!password) {
      setError(t("password") + t("validation:required"));
      return;
    }

    setLoading(true);
    // 成功路径保持 loading 直至跳转发生：防止 800ms 空窗期内按钮解禁被重复提交
    let loginSucceeded = false;
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          ...(need2fa && totpCode ? { totpCode: totpCode.trim() } : {}),
        }),
      });

      const data: Record<string, any> = await res.json();

      if (data.success) {
        loginSucceeded = true;
        setSuccess(data.message || t("loginSuccess"));
        const hide = message.loading(t("redirecting"), 1.5);
        // 401 踢出前的深链恢复：仅接受 /admin 开头的站内路径（防开放重定向，// 开头视为外链）
        const rawRedirect = router.query.redirect;
        const target =
          typeof rawRedirect === "string" && rawRedirect.startsWith("/admin") && !rawRedirect.startsWith("//")
            ? rawRedirect
            : "/admin";
        redirectTimerRef.current = setTimeout(() => {
          hide();
          router.push(target);
        }, 800);
      } else if (res.status === 429 && data.resetAt) {
        // 限流锁定：解析解锁时间戳启动倒计时（非法时间戳不启用，避免 NaN 挂死）
        const ts = new Date(data.resetAt).getTime();
        setLockUntil(Number.isFinite(ts) ? ts : null);
        setError(data.error || t("loginFailed"));
      } else if (data.need2fa) {
        // 服务端要求两步验证：展开验证码输入框，保留已输入的凭据供重试
        setNeed2fa(true);
        setError(data.error || t("loginFailed"));
      } else {
        setError(data.error || t("loginFailed"));
      }
    } catch (err) {
      const msg = err instanceof TypeError && err.message.includes("fetch")
        ? t("common:networkError")
        : t("loginFailed");
      setError(msg);
    } finally {
      // 仅失败路径恢复按钮；成功路径保持 loading 直到 800ms 后跳转（timer 卸载清理逻辑不受影响）
      if (!loginSucceeded) setLoading(false);
    }
  };

  const handleBack = () => {
    setStep("username");
    setPassword("");
    setTotpCode("");
    setNeed2fa(false);
    setError("");
    setSuccess("");
    setLockUntil(null);
    setRetryIn(0);
  };

  const inputStyle =
    "w-full px-4 py-3 text-sm rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-100/10 focus:border-zinc-400 dark:focus:border-zinc-500 transition-all";

  const btnPrimary =
    "w-full flex items-center justify-center gap-2 py-3 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm";

  const renderUsernameStep = () => (
    <AuthCard
      title={t("welcomeBack")}
      subtitle={t("loginSubtitle")}
      footer={
        <div className="flex flex-col items-center gap-4 mt-4">
          <span className="text-xs text-zinc-400 dark:text-zinc-500">
            {t("adminOnly")}
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
            placeholder={t("username")}
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
              aria-label={t("copyError")}
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

        <button type="submit" className={btnPrimary} disabled={loading} aria-label={t("common:next")}>
          {loading ? (
            <LoadingSpinner />
          ) : (
            <>
              <ChevronRight size={18} />
              {t("common:next")}
            </>
          )}
        </button>
      </form>
    </AuthCard>
  );

  const renderPasswordStep = () => (
    <AuthCard
      title={t("welcomeBack")}
      subtitle={t("inputPassword")}
      footer={
        <div className="flex flex-col gap-3 mt-4">
          <button
            type="button"
            onClick={handleBack}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-sm font-medium"
            aria-label={t("common:back")}
          >
            <ArrowLeft size={14} />
            {t("common:back")}
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
            placeholder={t("password")}
            className={inputStyle + " pl-11 pr-4"}
            autoComplete="current-password"
            autoFocus
          />
        </div>

        {need2fa && (
          <input
            id="login-totp"
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
            placeholder={t("totpCode")}
            className={inputStyle + " tracking-[0.5em] text-center"}
            autoComplete="one-time-code"
          />
        )}

        {error && (
          <div role="alert" className="flex items-start justify-between gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
            <span className="break-all">{retryIn > 0 ? t("loginLocked", { seconds: retryIn }) : error}</span>
            <button
              type="button"
              onClick={() => handleCopyError(error)}
              className="shrink-0 mt-0.5 p-1 rounded hover:bg-red-100 dark:hover:bg-red-800/30 transition-colors"
              aria-label={t("copyError")}
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
          aria-label={t("login")}
        >
          {loading ? (
            <LoadingSpinner />
          ) : (
            <>
              <ChevronRight size={18} />
              {t("login")}
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
