"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Descriptions, Tag, Alert, Form, Input, message, Tooltip } from "antd";
import { Button } from "@/components/ui/Button";
import { RefreshCw, Lock, Zap, Copy, Check } from "lucide-react";
import GlobalLoading from "@/components/Loading";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

interface SystemInfo {
  adminUsername: string;
  dbConnected: boolean;
  platformCount: number;
  keyCount: number;
}

export default function SystemPage() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [passwordForm] = Form.useForm();
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);

  // 自动模型 ID 状态
  const [autoModelId, setAutoModelId] = useState<string | null>(null);
  const [autoModelLoading, setAutoModelLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  /** 获取自动模型 ID 配置 */
  const fetchAutoModelId = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/config");
      const data = await res.json();
      if (data.success && data.data) {
        setAutoModelId(data.data["system:auto_model_id"] || null);
      }
    } catch {
      // 静默失败
    }
  }, []);

  /** 重新生成自动模型 ID */
  const regenerateAutoModelId = async () => {
    setAutoModelLoading(true);
    try {
      // 生成 fwp-auto-model- + 16 位随机 hex
      const hex = Array.from({ length: 16 }, () =>
        Math.floor(Math.random() * 16).toString(16)
      ).join("");
      const newId = `fwp-auto-model-${hex}`;

      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "system:auto_model_id", value: newId }),
      });
      const data = await res.json();
      if (data.success) {
        setAutoModelId(newId);
        message.success(t("system.auto_model_regenerated") || "自动模型 ID 已重新生成");
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setAutoModelLoading(false);
    }
  };

  /** 复制自动模型 ID */
  const copyAutoModelId = () => {
    if (autoModelId) {
      navigator.clipboard.writeText(autoModelId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // 修复：将 fetchInfo 提取为独立函数，供 useEffect 和按钮 onClick 共用
  const fetchInfo = async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/admin/stats", { signal });
      const data = await res.json();
      if (data.success && data.data) {
        setInfo({
          adminUsername: data.data.adminUsername || "",
          dbConnected: data.data.dbConnected ?? false,
          platformCount: data.data.activePlatforms || 0,
          keyCount: data.data.activeKeys || 0,
        });
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("获取系统信息失败:", err);
      setLoadError(true);
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  // 修复：添加 AbortController 防止组件卸载后的竞态请求
  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchInfo(controller.signal);
    fetchAutoModelId();
    return () => controller.abort();
  }, [fetchAutoModelId]);

  /** 修改密码提交处理 */
  const handleChangePassword = async (values: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }) => {
    setChangePasswordLoading(true);
    try {
      const res = await fetch("/api/admin/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (data.success) {
        message.success(t("auth.password_changed"));
        passwordForm.resetFields();
      } else {
        message.error(data.error || t("auth.password_change_failed"));
      }
    } catch {
      message.error(t("auth.password_change_failed"));
    } finally {
      setChangePasswordLoading(false);
    }
  };

  if (loading) {
    return <GlobalLoading size="large" />;
  }

  if (loadError) {
    return (
      <div>
        <div className="border-b border-zinc-100 dark:border-zinc-800 pb-4 mb-6">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-1">
            {t("admin.system")}
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400 text-sm">
            {t("system.db_status")}
          </p>
        </div>

        <Card className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900" aria-label={t("admin.system")}>
          <Alert
            type="error"
            showIcon
            message={t("common.error")}
            description={
              <Button
                variant="default"
                onClick={() => { setLoadError(false); fetchInfo(); }}
                icon={<RefreshCw size={14} />}
                size="sm"
              >
                {t("common.refresh") || "刷新"}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <div className="border-b border-zinc-100 dark:border-zinc-800 pb-4 mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-1">
          {t("admin.system")}
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400 text-sm">
          {t("system.db_status")}
        </p>
      </div>

      <Card className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900" aria-label={t("admin.system")}>
        <Descriptions column={1} bordered>
          <Descriptions.Item label={t("system.admin_init")}>
            {info?.adminUsername || t("common.not_set")}
          </Descriptions.Item>
          <Descriptions.Item label={t("system.db_status")}>
            <Tag color={info?.dbConnected ? "green" : "red"}>
              {info?.dbConnected
                ? t("system.db_connected")
                : t("system.db_disconnected")}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label={t("dashboard.active_platforms")}>
            {info?.platformCount ?? 0}
          </Descriptions.Item>
          <Descriptions.Item label={t("dashboard.active_keys")}>
            {info?.keyCount ?? 0}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* 修改密码卡片 */}
      <Card
        className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 mt-6"
        title={
          <span className="flex items-center gap-2">
            <Lock size={18} />
            {t("auth.change_password")}
          </span>
        }
      >
        <Form
          form={passwordForm}
          layout="vertical"
          onFinish={handleChangePassword}
          autoComplete="off"
        >
          <Form.Item
            name="currentPassword"
            label={t("auth.current_password")}
            rules={[{ required: true, message: t("validation.field_required") }]}
          >
            <Input.Password />
          </Form.Item>

          <Form.Item
            name="newPassword"
            label={t("auth.new_password")}
            rules={[
              { required: true, message: t("validation.field_required") },
              { min: 8, message: t("auth.password_too_short") },
            ]}
          >
            <Input.Password />
          </Form.Item>

          <Form.Item
            name="confirmPassword"
            label={t("auth.confirm_password")}
            dependencies={["newPassword"]}
            rules={[
              { required: true, message: t("validation.field_required") },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue("newPassword") === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error(t("auth.password_mismatch")));
                },
              }),
            ]}
          >
            <Input.Password />
          </Form.Item>

          <Form.Item>
            <Button
              variant="primary"
              type="submit"
              loading={changePasswordLoading}
              disabled={changePasswordLoading}
            >
              {t("auth.change_password")}
            </Button>
          </Form.Item>
        </Form>
      </Card>

      {/* 自动模型 ID 配置卡片 */}
      <Card
        className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 mt-6"
        title={
          <span className="flex items-center gap-2">
            <Zap size={18} />
            {t("system.auto_model_title") || "自动模型"}
          </span>
        }
      >
        <p className="text-zinc-500 dark:text-zinc-400 text-sm mb-4">
          {t("system.auto_model_desc") || "配置后，请求此模型 ID 时将自动轮询所有可用平台。"}
        </p>
        {autoModelId ? (
          <div className="flex items-center gap-3">
            <code className="flex-1 bg-zinc-100 dark:bg-zinc-800 px-3 py-2 rounded text-sm font-mono break-all">
              {autoModelId}
            </code>
            <Tooltip title={copied ? t("common.copied") : t("common.copy")}>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon={copied ? <Check size={14} /> : <Copy size={14} />}
                onClick={copyAutoModelId}
              />
            </Tooltip>
            <Button
              variant="default"
              size="sm"
              onClick={regenerateAutoModelId}
              loading={autoModelLoading}
            >
              {t("system.auto_model_regenerate") || "重新生成"}
            </Button>
          </div>
        ) : (
          <Button
            variant="primary"
            size="sm"
            onClick={regenerateAutoModelId}
            loading={autoModelLoading}
          >
            {t("system.auto_model_enable") || "启用自动模型"}
          </Button>
        )}
      </Card>
    </div>
  );
}
