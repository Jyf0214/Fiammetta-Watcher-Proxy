"use client";

import { useState, useEffect } from "react";
import { Form, Input, Button, message, Alert, Steps, Typography } from "antd";
import { Database, Key, Shield, CheckCircle, ArrowRight } from "lucide-react";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";

const { Text, Paragraph } = Typography;

interface SetupStatus {
  configured: boolean;
  missing: {
    DATABASE_URL: boolean;
    ADMIN_USERNAME: boolean;
    ADMIN_PASSWORD: boolean;
    JWT_SECRET: boolean;
  };
}

export default function SetupPage() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [statusLoading, setStatusLoading] = useState(true);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [currentStep, setCurrentStep] = useState(0);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/setup/status");
        const data = await res.json();
        if (data.success) {
          setSetupStatus(data.data);
          if (data.data.configured) {
            setCurrentStep(2); // 已配置，直接显示完成步骤
          }
        }
      } catch (error) {
        console.error("检查配置状态失败:", error);
      } finally {
        setStatusLoading(false);
      }
    };

    fetchStatus();
  }, []);

  const handleSubmit = async (values: {
    DATABASE_URL: string;
    ADMIN_USERNAME: string;
    ADMIN_PASSWORD: string;
    JWT_SECRET?: string;
    JWKS_KEY?: string;
  }) => {
    setLoading(true);
    try {
      const res = await fetch("/api/setup/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const data = await res.json();
      if (data.success) {
        message.success("配置成功！已保存到 db-config.json");
        setSuccess(true);
        setCurrentStep(2);

        // 3秒后自动跳转到首页
        setTimeout(() => {
          window.location.href = "/";
        }, 3000);
      } else {
        message.error(data.error || "配置失败");
      }
    } catch (error) {
      message.error("配置失败，请检查网络连接");
      console.error("配置失败:", error);
    } finally {
      setLoading(false);
    }
  };

  const steps = [
    {
      title: "数据库配置",
      icon: <Database size={20} />,
      content: (
        <ProCard title="数据库连接配置" className="mb-4">
          <Form form={form} layout="vertical" onFinish={handleSubmit}>
            <Form.Item
              name="DATABASE_URL"
              label="数据库连接地址"
              rules={[
                { required: true, message: "请输入数据库连接地址" },
                {
                  pattern: /^(postgresql|mysql|postgres):\/\/.+/,
                  message: "必须以 postgresql://、mysql:// 或 postgres:// 开头",
                },
              ]}
              extra="支持 PostgreSQL 或 MySQL 数据库"
            >
              <Input
                placeholder="postgresql://user:password@localhost:5432/dbname"
                size="large"
              />
            </Form.Item>

            <Form.Item
              name="ADMIN_USERNAME"
              label="管理员用户名"
              rules={[{ required: true, message: "请输入管理员用户名" }]}
            >
              <Input placeholder="admin" size="large" />
            </Form.Item>

            <Form.Item
              name="ADMIN_PASSWORD"
              label="管理员密码"
              rules={[
                { required: true, message: "请输入管理员密码" },
                { min: 6, message: "密码至少6位" },
              ]}
            >
              <Input.Password placeholder="至少6位密码" size="large" />
            </Form.Item>

            <Form.Item
              name="JWT_SECRET"
              label="JWT 密钥（可选）"
              extra="留空将自动生成安全密钥。与 JWKS_KEY 二选一"
            >
              <Input.Password placeholder="留空自动生成" size="large" />
            </Form.Item>

            <Form.Item
              name="JWKS_KEY"
              label="JWKS_KEY（可选）"
              extra="用于 RS256 非对称加密的 JWKS 密钥。与 JWT_SECRET 二选一"
            >
              <Input.TextArea
                placeholder='{"keys":[{"kty":"RSA","d":"...",...}]}'
                rows={4}
                size="large"
              />
            </Form.Item>

            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                loading={loading}
                size="large"
                block
              >
                保存配置
              </Button>
            </Form.Item>
          </Form>
        </ProCard>
      ),
    },
    {
      title: "配置确认",
      icon: <Key size={20} />,
      content: (
        <ProCard title="配置确认" className="mb-4">
          <Alert
            message="配置说明"
            description={
              <div>
                <Paragraph>
                  配置完成后，系统将自动：
                </Paragraph>
                <ul className="list-disc pl-5 space-y-2">
                  <li>写入数据库配置文件 (data/db-config.json)</li>
                  <li>更新运行时环境变量</li>
                  <li>重新初始化数据库连接</li>
                  <li>创建管理员账户</li>
                </ul>
                <Paragraph type="secondary" className="mt-4">
                  注意：系统已配置时不允许通过此页面修改。如需更改配置，请手动编辑 data/db-config.json 文件。
                </Paragraph>
              </div>
            }
            type="warning"
            showIcon
          />
        </ProCard>
      ),
    },
    {
      title: "完成",
      icon: <Shield size={20} />,
      content: (
        <ProCard title="配置完成" className="mb-4">
          {success ? (
            <Alert
              message="配置成功！"
              description="系统已重新配置，即将自动跳转到首页..."
              type="success"
              showIcon
              icon={<CheckCircle />}
            />
          ) : setupStatus?.configured ? (
            <Alert
              message="系统已配置"
              description="数据库环境变量已配置完成，系统运行正常。"
              type="success"
              showIcon
              icon={<CheckCircle />}
            />
          ) : (
            <Alert
              message="等待配置"
              description="请完成数据库配置以继续。"
              type="info"
              showIcon
            />
          )}
        </ProCard>
      ),
    },
  ];

  if (statusLoading) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-4"></div>
            <Text type="secondary">正在检查配置状态...</Text>
          </div>
        </div>
      </PageContainer>
    );
  }

  // 如果已配置，直接显示完成状态
  if (setupStatus?.configured) {
    return (
      <PageContainer>
        <PageHeader
          icon={<Database size={20} className="text-green-500" />}
          title="系统已配置"
          description="数据库环境变量已配置完成"
        />
        <ProCard>
          <Alert
            message="配置完成"
            description="数据库环境变量已配置完成，系统运行正常。如需更改配置，请手动编辑 data/db-config.json 文件。"
            type="success"
            showIcon
            icon={<CheckCircle />}
          />
          <div className="mt-4">
            <Button type="primary" href="/">
              进入系统
            </Button>
          </div>
        </ProCard>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<Database size={20} className="text-blue-500" />}
        title="系统设置"
        description="配置数据库连接和管理员账户"
      />

      <ProCard className="mb-6">
        <Steps
          current={currentStep}
          items={steps.map((step) => ({
            title: step.title,
            icon: step.icon,
          }))}
          className="mb-6"
        />
      </ProCard>

      <div className="max-w-2xl mx-auto">
        {steps[currentStep].content}

        {currentStep < 2 && !success && (
          <div className="flex justify-end mt-4">
            <Button
              type="primary"
              onClick={() => setCurrentStep(currentStep + 1)}
              icon={<ArrowRight size={16} />}
            >
              下一步
            </Button>
          </div>
        )}
      </div>

      {success && (
        <div className="text-center mt-6">
          <Button type="primary" size="large" href="/">
            立即进入系统
          </Button>
        </div>
      )}
    </PageContainer>
  );
}
