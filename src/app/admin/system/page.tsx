"use client";

import { useState, useEffect } from "react";
import { Descriptions, Tag, Alert, Form, Input, message } from "antd";
import { Button } from "@/components/ui/Button";
import { RefreshCw, Lock, Settings } from "lucide-react";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
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
      setLoadError(true);
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchInfo(controller.signal);
    return () => controller.abort();
  }, []);

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
      <PageContainer>
        <PageHeader
          icon={<Settings size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("admin.system")}
          description={t("system.db_status")}
        />
        <ProCard>
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
        </ProCard>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<Settings size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title={t("admin.system")}
        description={t("system.db_status")}
      />

      <ProCard className="mb-4">
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
      </ProCard>

      <ProCard
        title={
          <span className="flex items-center gap-2">
            <Lock size={16} />
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
      </ProCard>
    </PageContainer>
  );
}
