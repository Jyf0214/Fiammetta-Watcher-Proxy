/**
 * 系统设置页
 *
 * 功能：
 * - 系统状态信息展示（管理员、数据库状态、平台/Key 数量）
 * - 修改管理员密码
 *
 * 主分支对应文件：src/app/admin/system/page.tsx
 * 迁移变更：
 * - App Router → Pages Router
 * - @lobehub/ui 组件 → Ant Design 5
 * - lucide-react 图标 → @ant-design/icons
 * - react-i18next → 中文直接写死
 */

import { useState, useEffect } from "react";
import {
  Card,
  Descriptions,
  Tag,
  Form,
  Input,
  Button,
  message,
  Space,
  Spin,
  Alert,
  Typography,
} from "antd";
import {
  SettingOutlined,
  LockOutlined,
  ReloadOutlined,
  DatabaseOutlined,
  CloudServerOutlined,
  KeyOutlined,
  UserOutlined,
} from "@ant-design/icons";

const { Title } = Typography;

// ==================== 类型定义 ====================

interface SystemInfo {
  adminUsername: string;
  dbConnected: boolean;
  platformCount: number;
  keyCount: number;
}

// ==================== 页面组件 ====================

export default function SystemPage() {
  // 系统状态
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  // 修改密码
  const [passwordForm] = Form.useForm();
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);

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

  // ─── 修改密码 ───
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
      setChangePasswordLoading(false);
    }
  };

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
            onClick={() => {
              setLoading(true);
              setLoadError(false);
              setRefreshKey((k) => k + 1);
            }}
            size="small"
          >
            刷新
          </Button>
        }
      >
        <Descriptions column={1} bordered size="middle">
          <Descriptions.Item label="管理员用户名">
            <Space>
              <UserOutlined />
              {info?.adminUsername || "未设置"}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="数据库状态">
            <Tag color={info?.dbConnected ? "green" : "red"} icon={<DatabaseOutlined />}>
              {info?.dbConnected ? "已连接" : "未连接"}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="活跃平台数">
            <Space>
              <CloudServerOutlined />
              {info?.platformCount ?? 0}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="活跃密钥数">
            <Space>
              <KeyOutlined />
              {info?.keyCount ?? 0}
            </Space>
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
      >
        <Form
          form={passwordForm}
          layout="vertical"
          onFinish={handleChangePassword}
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
              loading={changePasswordLoading}
              disabled={changePasswordLoading}
            >
              修改密码
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
