"use client";

import { useState, useEffect } from "react";
import { Card, Descriptions, Tag, Alert, Form, Input, message } from "antd";
import { Button } from "@/components/ui/Button";
import { RefreshCw, Lock } from "lucide-react";
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

  const fetchInfo = async () => {
    try {
      const res = await fetch("/api/admin/stats");
      const data = await res.json();
      if (data.success) {
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
      console.error("获取系统信息失败:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchInfo();
  }, []);

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
    </div>
  );
}
