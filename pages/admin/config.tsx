/**
 * 系统配置页
 *
 * 功能：
 * - 系统状态信息展示（管理员、数据库状态、平台/Key 数量）
 * - 修改管理员密码
 * - 自动模型 ID 配置
 *
 * 主分支对应文件：src/app/admin/system/page.tsx + src/app/admin/auto-model/page.tsx
 * 迁移变更：
 * - @lobehub/ui 组件 → Ant Design 5
 * - lucide-react 图标 → @ant-design/icons
 * - react-i18next → 中文直接写死
 */

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  Descriptions,
  Tag,
  Form,
  Input,
  Button,
  message,
  Space,
  Typography,
  Divider,
  Spin,
  Alert,
  InputNumber,
  Tooltip,
} from "antd";
import {
  SettingOutlined,
  LockOutlined,
  ReloadOutlined,
  CopyOutlined,
  CheckOutlined,
  ThunderboltOutlined,
  DatabaseOutlined,
  CloudServerOutlined,
  KeyOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";

const { Title, Text } = Typography;

// ==================== 类型定义 ====================

interface SystemInfo {
  adminUsername: string;
  dbConnected: boolean;
  platformCount: number;
  keyCount: number;
}

interface ConfigData {
  [key: string]: string;
}

// ==================== 页面组件 ====================

export default function ConfigPage() {
  // 系统状态
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // 修改密码
  const [passwordForm] = Form.useForm();
  const [passwordLoading, setPasswordLoading] = useState(false);

  // 自动模型配置
  const [autoModelId, setAutoModelId] = useState<string>("");
  const [autoModelLoading, setAutoModelLoading] = useState(false);
  const [autoModelCopied, setAutoModelCopied] = useState(false);

  // 刷新标记
  const [refreshKey, setRefreshKey] = useState(0);

  // ─── 加载系统状态 ───
  useEffect(() => {
    const controller = new AbortController();

    const fetchInfo = async () => {
      try {
        const res = await fetch("/api/admin/stats", { signal: controller.signal });
        const data: any = await res.json();
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
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    fetchInfo();
    return () => controller.abort();
  }, [refreshKey]);

  // ─── 加载自动模型配置 ───
  useEffect(() => {
    const controller = new AbortController();

    const fetchConfig = async () => {
      try {
        const res = await fetch("/api/admin/config", { signal: controller.signal });
        const data: any = await res.json();
        if (data.success && data.data) {
          setAutoModelId(data.data["system:auto_model_id"] || "");
        }
      } catch {
        // 静默失败
      }
    };

    fetchConfig();
    return () => controller.abort();
  }, []);

  // ─── 修改密码 ───
  const handlePasswordChange = async (values: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }) => {
    setPasswordLoading(true);
    try {
      const res = await fetch("/api/admin/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data: any = await res.json();
      if (data.success) {
        message.success("密码修改成功");
        passwordForm.resetFields();
      } else {
        message.error(data.error || "密码修改失败");
      }
    } catch {
      message.error("密码修改失败");
    } finally {
      setPasswordLoading(false);
    }
  };

  // ─── 重新生成自动模型 ID ───
  const regenerateAutoModelId = useCallback(async () => {
    setAutoModelLoading(true);
    try {
      const hex = Array.from({ length: 16 }, () =>
        Math.floor(Math.random() * 16).toString(16),
      ).join("");
      const newId = `fwp-auto-model-${hex}`;

      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "system:auto_model_id", value: newId }),
      });
      const data: any = await res.json();
      if (data.success) {
        setAutoModelId(newId);
        message.success("自动模型 ID 已重新生成");
      } else {
        message.error(data.error || "操作失败");
      }
    } catch {
      message.error("操作失败");
    } finally {
      setAutoModelLoading(false);
    }
  }, []);

  // ─── 复制自动模型 ID ───
  const copyAutoModelId = useCallback(async () => {
    if (!autoModelId) return;
    try {
      await navigator.clipboard.writeText(autoModelId);
      setAutoModelCopied(true);
      message.success("已复制到剪贴板");
      setTimeout(() => setAutoModelCopied(false), 2000);
    } catch {
      message.error("复制失败");
    }
  }, [autoModelId]);

  // ─── 加载中 ───
  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", paddingTop: 120 }}>
        <Spin size="large" />
      </div>
    );
  }

  // ─── 加载错误 ───
  if (loadError) {
    return (
      <Card>
        <Alert
          type="error"
          showIcon
          message="加载失败"
          description={
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                setLoadError(false);
                setLoading(true);
                setRefreshKey((k) => k + 1);
              }}
            >
              重试
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      {/* 系统状态 */}
      <Card
        title={
          <Space>
            <SettingOutlined />
            <span>系统状态</span>
          </Space>
        }
        style={{ marginBottom: 24 }}
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => setRefreshKey((k) => k + 1)}
            size="small"
          >
            刷新
          </Button>
        }
      >
        <Descriptions column={1} bordered size="middle">
          <Descriptions.Item label="管理员用户名">
            {info?.adminUsername || "未设置"}
          </Descriptions.Item>
          <Descriptions.Item label="数据库状态">
            <Tag color={info?.dbConnected ? "green" : "red"}>
              {info?.dbConnected ? "已连接" : "未连接"}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="活跃平台数">
            <CloudServerOutlined style={{ marginRight: 6 }} />
            {info?.platformCount ?? 0}
          </Descriptions.Item>
          <Descriptions.Item label="活跃密钥数">
            <KeyOutlined style={{ marginRight: 6 }} />
            {info?.keyCount ?? 0}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {/* 修改密码 */}
      <Card
        title={
          <Space>
            <LockOutlined />
            <span>修改密码</span>
          </Space>
        }
        style={{ marginBottom: 24 }}
      >
        <Form
          form={passwordForm}
          layout="vertical"
          onFinish={handlePasswordChange}
          autoComplete="off"
          style={{ maxWidth: 400 }}
        >
          <Form.Item
            name="currentPassword"
            label="当前密码"
            rules={[{ required: true, message: "请输入当前密码" }]}
          >
            <Input.Password />
          </Form.Item>

          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: "请输入新密码" },
              { min: 8, message: "密码至少 8 个字符" },
            ]}
          >
            <Input.Password />
          </Form.Item>

          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={["newPassword"]}
            rules={[
              { required: true, message: "请确认新密码" },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue("newPassword") === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error("两次输入的密码不一致"));
                },
              }),
            ]}
          >
            <Input.Password />
          </Form.Item>

          <Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              loading={passwordLoading}
              disabled={passwordLoading}
            >
              修改密码
            </Button>
          </Form.Item>
        </Form>
      </Card>

      {/* 自动模型配置 */}
      <Card
        title={
          <Space>
            <ThunderboltOutlined />
            <span>自动模型</span>
          </Space>
        }
        style={{ marginBottom: 24 }}
      >
        <Alert
          type="info"
          showIcon
          icon={<InfoCircleOutlined />}
          message="自动模型"
          description="配置自动模型 ID 后，所有请求使用该 ID 时，系统会自动从可用平台中选择一个模型进行路由。"
          style={{ marginBottom: 16 }}
        />

        <div style={{ marginBottom: 16 }}>
          <Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
            当前自动模型 ID
          </Text>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Input
              value={autoModelId}
              readOnly
              style={{ fontFamily: "monospace" }}
              addonAfter={
                <Tooltip title={autoModelCopied ? "已复制" : "复制"}>
                  <Button
                    type="text"
                    size="small"
                    icon={autoModelCopied ? <CheckOutlined /> : <CopyOutlined />}
                    onClick={copyAutoModelId}
                    disabled={!autoModelId}
                  />
                </Tooltip>
              }
            />
          </div>
        </div>

        <Space>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            loading={autoModelLoading}
            onClick={regenerateAutoModelId}
          >
            重新生成
          </Button>
        </Space>
      </Card>
    </div>
  );
}
