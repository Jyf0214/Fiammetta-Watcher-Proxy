"use client";

import { useState } from "react";
import { Radio, Upload, message, Alert, Typography, Space, Divider, Tag } from "antd";
import {
  DownloadOutlined,
  UploadOutlined,
  DatabaseOutlined,
  CloudServerOutlined,
  FileTextOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
} from "@ant-design/icons";
import { Button } from "@/components/ui/Button";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";

const { Text, Title } = Typography;

type ExportType = "system" | "data" | "all";

interface ImportResult {
  success: boolean;
  message: string;
  details?: Record<string, { imported: number; skipped: number }>;
}

export default function DataManagerPage() {
  const [exportType, setExportType] = useState<ExportType>("all");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  // 导出数据
  const handleExport = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ type: exportType });
      const res = await fetch(`/api/admin/export?${params}`);

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "导出失败");
      }

      // 下载文件
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fwp-export-${exportType}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      message.success("导出成功");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "导出失败");
    } finally {
      setExporting(false);
    }
  };

  // 导入数据
  const handleImport = async (file: File) => {
    setImporting(true);
    setImportResult(null);

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // 验证导入数据格式
      if (!data.version || !data.exportedAt) {
        throw new Error("无效的导入文件格式");
      }

      const res = await fetch("/api/admin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const result = await res.json();
      setImportResult(result);

      if (result.success) {
        message.success(result.message);
      } else {
        message.error(result.error || "导入失败");
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : "导入失败");
      setImportResult({
        success: false,
        message: err instanceof Error ? err.message : "导入失败",
      });
    } finally {
      setImporting(false);
    }
  };

  // 文件上传前的验证
  const beforeUpload = (file: File) => {
    const isJson = file.type === "application/json" || file.name.endsWith(".json");
    if (!isJson) {
      message.error("只能导入 JSON 文件");
      return false;
    }

    const isLt10M = file.size / 1024 / 1024 < 10;
    if (!isLt10M) {
      message.error("文件大小不能超过 10MB");
      return false;
    }

    handleImport(file);
    return false; // 阻止自动上传
  };

  return (
    <PageContainer>
      <PageHeader
        icon={<DatabaseOutlined size={20} className="text-zinc-500 dark:text-zinc-400" />}
        title="数据管理"
        description="导出和导入系统数据，支持备份和迁移"
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 导出区域 */}
        <ProCard title="数据导出">
          <div className="space-y-4">
            <Alert
              message="导出说明"
              description="导出的数据将包含系统配置和/或业务数据。敏感信息（如 API Key、代理地址）会自动脱敏处理。"
              type="info"
              showIcon
            />

            <div>
              <Text className="block mb-2 font-medium">选择导出类型：</Text>
              <Radio.Group
                value={exportType}
                onChange={(e) => setExportType(e.target.value)}
                className="flex flex-col gap-2"
              >
                <Radio value="system">
                  <Space>
                    <CloudServerOutlined />
                    <span>系统配置</span>
                    <Tag color="blue">推荐</Tag>
                  </Space>
                  <br />
                  <Text type="secondary" className="text-xs ml-5">
                    平台、模型映射、代理、套餐等配置数据
                  </Text>
                </Radio>
                <Radio value="data">
                  <Space>
                    <FileTextOutlined />
                    <span>业务数据</span>
                  </Space>
                  <br />
                  <Text type="secondary" className="text-xs ml-5">
                    API Keys、请求日志、统计、审计日志等
                  </Text>
                </Radio>
                <Radio value="all">
                  <Space>
                    <DatabaseOutlined />
                    <span>全部导出</span>
                    <Tag color="orange">完整备份</Tag>
                  </Space>
                  <br />
                  <Text type="secondary" className="text-xs ml-5">
                    包含以上所有数据
                  </Text>
                </Radio>
              </Radio.Group>
            </div>

            <Button
              variant="primary"
              icon={<DownloadOutlined />}
              onClick={handleExport}
              loading={exporting}
              block
            >
              导出数据
            </Button>
          </div>
        </ProCard>

        {/* 导入区域 */}
        <ProCard title="数据导入">
          <div className="space-y-4">
            <Alert
              message="导入说明"
              description={
                <ul className="list-disc list-inside space-y-1">
                  <li>仅导入新数据，不会覆盖或删除现有数据</li>
                  <li>脱敏的数据（含 ***）会被自动跳过</li>
                  <li>已存在的数据（按名称或地址匹配）会被跳过</li>
                  <li>支持导入本系统导出的 JSON 文件</li>
                </ul>
              }
              type="warning"
              showIcon
            />

            <Upload.Dragger
              accept=".json"
              showUploadList={false}
              beforeUpload={beforeUpload}
              disabled={importing}
            >
              <p className="text-4xl text-zinc-300 dark:text-zinc-600">
                <UploadOutlined />
              </p>
              <p className="text-zinc-600 dark:text-zinc-400">
                {importing ? "正在导入..." : "点击或拖拽 JSON 文件到此处"}
              </p>
              <p className="text-xs text-zinc-400">
                支持 .json 格式，最大 10MB
              </p>
            </Upload.Dragger>

            {/* 导入结果 */}
            {importResult && (
              <div className="mt-4">
                <Divider />
                <div className="flex items-center gap-2 mb-3">
                  {importResult.success ? (
                    <CheckCircleOutlined className="text-green-500 text-lg" />
                  ) : (
                    <ExclamationCircleOutlined className="text-red-500 text-lg" />
                  )}
                  <Text strong className={importResult.success ? "text-green-600" : "text-red-600"}>
                    {importResult.message}
                  </Text>
                </div>

                {importResult.details && (
                  <div className="space-y-2">
                    {Object.entries(importResult.details).map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between text-sm">
                        <Text type="secondary">{formatImportKey(key)}</Text>
                        <Space size="small">
                          <Tag color="green">导入 {value.imported}</Tag>
                          <Tag color="default">跳过 {value.skipped}</Tag>
                        </Space>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </ProCard>
      </div>

      {/* 使用提示 */}
      <ProCard title="使用提示" className="mt-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
          <div>
            <Title level={5}>导出场景</Title>
            <ul className="space-y-2 text-zinc-600 dark:text-zinc-400">
              <li>• 迁移到新服务器时，先导出再导入</li>
              <li>• 定期备份系统配置</li>
              <li>• 复制配置到其他环境</li>
            </ul>
          </div>
          <div>
            <Title level={5}>导入注意事项</Title>
            <ul className="space-y-2 text-zinc-600 dark:text-zinc-400">
              <li>• 导入不会覆盖现有数据</li>
              <li>• 脱敏的敏感信息会被跳过</li>
              <li>• 导入后建议检查平台配置</li>
            </ul>
          </div>
        </div>
      </ProCard>
    </PageContainer>
  );
}

/**
 * 格式化导入字段名
 */
function formatImportKey(key: string): string {
  const map: Record<string, string> = {
    platforms: "平台",
    modelMaps: "模型映射",
    proxies: "代理",
    proxyPools: "代理池",
    plans: "套餐模板",
    apiKeys: "API Keys",
    configs: "系统配置",
    requestLogs: "请求日志",
    dailyStats: "每日统计",
    auditLogs: "审计日志",
    systemEvents: "系统事件",
  };
  return map[key] || key;
}
