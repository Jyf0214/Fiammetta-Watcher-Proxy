"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Input, Form, message } from "antd";
import { Mail, Lock, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import AuthLayout from "@/components/auth/AuthLayout";
import AuthCard from "@/components/auth/AuthCard";
import "@/lib/i18n";

export default function AdminLoginPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"username" | "password">("username");
  const [username, setUsername] = useState("");
  const inputRef = useRef<React.ComponentRef<typeof Input>>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    inputRef.current?.focus();
  }, [step]);

  const handleCheckUser = (values: { username: string }) => {
    setUsername(values.username);
    setStep("password");
  };

  const handleLogin = async (values: { password: string }) => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: values.password }),
      });

      const data = await res.json();

      if (data.success) {
        message.success(data.message || t("auth.login_success"));
        router.push("/admin");
      } else {
        message.error(data.error || t("auth.login_failed"));
      }
    } catch {
      message.error(t("auth.login_failed"));
    } finally {
      setLoading(false);
    }
  };

  const handleBackToUsername = () => {
    setStep("username");
    setUsername("");
  };

  const inputStyle = {
    padding: "14px 16px",
    height: 56,
    fontSize: 16,
    lineHeight: 1.6,
    borderRadius: 12,
  };

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
      <Form form={form} layout="vertical" onFinish={handleCheckUser}>
        <Form.Item
          name="username"
          rules={[
            { required: true, message: t("auth.username") + "不能为空" },
          ]}
          style={{ marginBottom: 0 }}
        >
          <Input
            placeholder={t("auth.username")}
            ref={inputRef}
            size="large"
            prefix={<Mail size={16} className="mx-2 text-zinc-400" />}
            style={inputStyle}
            suffix={
              <button
                type="button"
                onClick={() => form.submit()}
                className="flex items-center justify-center w-10 h-10 rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:opacity-90 transition-opacity"
              >
                <ChevronRight size={16} />
              </button>
            }
          />
        </Form.Item>
      </Form>
    </AuthCard>
  );

  const renderPasswordStep = () => (
    <AuthCard
      title={t("auth.welcome_back") || "欢迎回来"}
      subtitle={t("auth.input_password") || "输入密码以登录"}
      footer={
        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={handleBackToUsername}
            className="flex items-center justify-center gap-2 w-full py-3 rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-sm font-medium"
          >
            <ChevronRight size={14} className="rotate-180" />
            {t("common.back") || "返回"}
          </button>
        </div>
      }
    >
      <span className="text-lg text-zinc-900 dark:text-zinc-100 font-medium">
        {username}
      </span>
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 16 }}
        onFinish={handleLogin}
      >
        <Form.Item
          name="password"
          rules={[
            { required: true, message: t("auth.password") + "不能为空" },
          ]}
          style={{ marginBottom: 0 }}
        >
          <Input.Password
            placeholder={t("auth.password")}
            ref={inputRef}
            size="large"
            prefix={<Lock size={16} className="mx-2 text-zinc-400" />}
            style={inputStyle}
            suffix={
              <button
                type="button"
                onClick={() => form.submit()}
                disabled={loading}
                className="flex items-center justify-center w-10 h-10 rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {loading ? (
                  <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <ChevronRight size={16} />
                )}
              </button>
            }
          />
        </Form.Item>
      </Form>
    </AuthCard>
  );

  return (
    <AuthLayout>
      {step === "username" && renderUsernameStep()}
      {step === "password" && renderPasswordStep()}
    </AuthLayout>
  );
}
