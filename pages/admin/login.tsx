/**
 * 管理后台登录页
 *
 * 功能：
 * - 两步登录（用户名 → 密码）
 * - 错误信息展示（支持一键复制）
 * - 忘记密码（调用重置 API）
 * - 自动聚焦
 * - 登录成功后跳转
 *
 * 主分支对应文件：src/app/admin/login/page.tsx
 * 迁移变更：
 * - App Router → Pages Router
 * - @lobehub/ui toast → antd message
 * - AuthLayout/AuthCard → Ant Design Card + 布局组件
 * - lucide-react 图标 → @ant-design/icons
 * - react-i18next → 中文直接写死
 */

import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { Card, Input, Button, Typography, Space, message } from "antd";
import {
  UserOutlined,
  LockOutlined,
  RightOutlined,
  ArrowLeftOutlined,
  KeyOutlined,
  CopyOutlined,
  CheckOutlined,
} from "@ant-design/icons";

const { Title, Text, Paragraph } = Typography;

export default function AdminLoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"username" | "password">("username");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [copied, setCopied] = useState(false);

  // 复制错误信息
  const handleCopyError = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error("复制失败，请手动复制");
    }
  };

  // 自动聚焦
  useEffect(() => {
    const el = document.getElementById(step === "username" ? "login-username" : "login-password");
    el?.focus();
  }, [step]);

  // 提交用户名
  const handleSubmitUsername = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    if (!username.trim()) {
      setError("用户名不能为空");
      return;
    }
    setStep("password");
  };

  // 登录
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (!password) {
      setError("密码不能为空");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data: any = await res.json();

      if (data.success) {
        setSuccess(data.message || "登录成功");
        message.success("登录成功，正在跳转...");
        setTimeout(() => router.push("/admin"), 800);
      } else {
        setError(data.error || "登录失败");
      }
    } catch (err) {
      const msg = err instanceof TypeError && err.message.includes("fetch")
        ? "网络错误，请检查连接"
        : "登录失败";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  // 返回用户名步骤
  const handleBack = () => {
    setStep("username");
    setPassword("");
    setError("");
    setSuccess("");
  };

  // 忘记密码
  const handleForgotPassword = async () => {
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/auth/reset-password", { method: "POST" });
      const data: any = await res.json();
      if (data.success) {
        setSuccess(data.message || "密码重置请求已提交");
      } else {
        setError(data.error || "密码重置失败");
      }
    } catch {
      setError("网络错误，请检查连接");
    } finally {
      setLoading(false);
    }
  };

  // 错误提示渲染
  const renderError = () => error ? (
    <div style={{
      display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8,
      padding: "8px 12px", borderRadius: 8,
      background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", fontSize: 13,
    }}>
      <span style={{ wordBreak: "break-all" }}>{error}</span>
      <Button
        type="text"
        size="small"
        icon={copied ? <CheckOutlined /> : <CopyOutlined />}
        onClick={() => handleCopyError(error)}
        style={{ color: "#dc2626", flexShrink: 0 }}
      />
    </div>
  ) : null;

  // 成功提示渲染
  const renderSuccess = () => success ? (
    <div style={{
      padding: "8px 12px", borderRadius: 8,
      background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#16a34a", fontSize: 13,
    }}>
      {success}
    </div>
  ) : null;

  // 用户名步骤
  const renderUsernameStep = () => (
    <Card style={{ width: "100%", maxWidth: 440, borderRadius: 16 }}>
      <div style={{ marginBottom: 48 }}>
        <Title level={2} style={{ marginBottom: 8, fontWeight: 700 }}>欢迎回来</Title>
        <Paragraph style={{ color: "#71717a", fontSize: 16, marginBottom: 0 }}>
          输入用户名继续
        </Paragraph>
      </div>

      <form onSubmit={handleSubmitUsername} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Input
          id="login-username"
          size="large"
          prefix={<UserOutlined style={{ color: "#a1a1aa" }} />}
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          style={{ borderRadius: 12, padding: "12px 16px" }}
        />

        {renderError()}
        {renderSuccess()}

        <Button
          type="primary"
          htmlType="submit"
          size="large"
          block
          loading={loading}
          icon={<RightOutlined />}
          style={{ borderRadius: 12, height: 48, fontWeight: 500 }}
        >
          下一步
        </Button>
      </form>

      <div style={{ textAlign: "center", marginTop: 24 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>仅限管理员登录</Text>
      </div>
    </Card>
  );

  // 密码步骤
  const renderPasswordStep = () => (
    <Card style={{ width: "100%", maxWidth: 440, borderRadius: 16 }}>
      <div style={{ marginBottom: 48 }}>
        <Title level={2} style={{ marginBottom: 8, fontWeight: 700 }}>欢迎回来</Title>
        <Paragraph style={{ color: "#71717a", fontSize: 16, marginBottom: 0 }}>
          输入密码以登录
        </Paragraph>
      </div>

      <div style={{
        padding: "8px 16px", borderRadius: 10,
        background: "#f4f4f5", marginBottom: 24,
        fontSize: 15, fontWeight: 500, color: "#18181b",
      }}>
        {username}
      </div>

      <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Input.Password
          id="login-password"
          size="large"
          prefix={<LockOutlined style={{ color: "#a1a1aa" }} />}
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus
          style={{ borderRadius: 12, padding: "12px 16px" }}
        />

        {renderError()}
        {renderSuccess()}

        <Button
          type="primary"
          htmlType="submit"
          size="large"
          block
          loading={loading}
          icon={<RightOutlined />}
          style={{ borderRadius: 12, height: 48, fontWeight: 500 }}
        >
          登录
        </Button>
      </form>

      <Space direction="vertical" style={{ width: "100%", marginTop: 16 }}>
        <Button
          block
          icon={<KeyOutlined />}
          onClick={handleForgotPassword}
          disabled={loading}
          style={{ borderRadius: 12 }}
        >
          忘记密码
        </Button>
        <Button
          block
          icon={<ArrowLeftOutlined />}
          onClick={handleBack}
          style={{ borderRadius: 12 }}
        >
          返回
        </Button>
      </Space>
    </Card>
  );

  // 外层布局
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      background: "#fafafa",
      padding: 16,
    }}>
      <Card
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          borderRadius: 16,
          border: "1px solid #e4e4e7",
          overflow: "hidden",
        }}
        styles={{ body: { flex: 1, display: "flex", flexDirection: "column" } }}
      >
        {/* 品牌头 */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px" }}>
          <div style={{
            width: 28, height: 28,
            background: "#18181b",
            borderRadius: 8,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{ color: "#fff", fontSize: 11, fontWeight: 800 }}>FW</span>
          </div>
          <span style={{ fontSize: 18, fontWeight: 700, color: "#18181b" }}>Fiammetta</span>
        </div>

        {/* 居中内容 */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          {step === "username" ? renderUsernameStep() : renderPasswordStep()}
        </div>

        {/* 底部版权 */}
        <div style={{ textAlign: "center", padding: "16px 0" }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Fiammetta Watcher Proxy © {new Date().getFullYear()}
          </Text>
        </div>
      </Card>
    </div>
  );
}
