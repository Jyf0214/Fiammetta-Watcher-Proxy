/**
 * 数据导入导出页
 *
 * 功能：
 * - 数据导出（系统配置 / 业务数据 / 全部导出）
 * - 数据导入（拖拽或点击上传 JSON 文件）
 * - 导入结果展示（每张表的导入/跳过数量）
 * - 导入前预览（显示文件基本信息）
 *
 * API 端点：
 * - GET  /api/admin/export?type=xxx — 导出数据（返回 JSON 文件）
 * - POST /api/admin/import — 导入数据（接收 JSON）
 */

import { useState, useRef, useCallback } from "react";
import {
  Card,
  Button,
  Radio,
  Space,
  Typography,
  Alert,
  Upload,
  Table,
  Tag,
  Progress,
  Divider,
  Spin,
  message,
} from "antd";
import type { UploadFile } from "antd";
import {
  DownloadOutlined,
  UploadOutlined,
  DatabaseOutlined,
  CloudOutlined,
  FileTextOutlined,
  CheckCircleOutlined,
  InfoCircleOutlined,
  ExclamationCircleOutlined,
} from "@ant-design/icons";

const { Title, Text, Paragraph } = Typography;
const { Dragger } = Upload;

// ==================== 类型定义 ====================

type ExportType = "system" | "data" | "all";

interface ImportResult {
  success: boolean;
  message: string;
  details?: Record<string, { imported: number; skipped: number }>;
}

// ==================== 导入字段名格式化 ====================

const FIELD_NAME_MAP: Record<string, string> = {
  platforms: "平台",
  modelMappings: "模型映射",
  modelMaps: "模型映射",
  proxies: "代理",
  proxyPools: "代理池",
  apiKeys: "API 密钥",
  configs: "系统配置",
  requestLogs: "请求日志",
  dailyStats: "每日统计",
  auditLogs: "审计日志",
  systemEvents: "系统事件",
  plans: "套餐模板",
};

function formatFieldName(key: string): string {
  return FIELD_NAME_MAP[key] || key;
}

// ==================== 导出选项配置 ====================

const EXPORT_OPTIONS: {
  value: ExportType;
  label: string;
  description: string;
  icon: React.ReactNode;
  tag?: string;
}[] = [
  {
    value: "system",
    label: "系统配置",
    description: "仅导出系统配置项（管理员设置、自动模型 ID 等）",
    icon: <CloudOutlined />,
    tag: "配置",
  },
  {
    value: "data",
    label: "业务数据",
    description: "导出平台、密钥、模型映射、代理、日志等业务数据",
    icon: <FileTextOutlined />,
  },
  {
    value: "all",
    label: "全部导出",
    description: "同时导出系统配置和业务数据（推荐备份使用）",
    icon: <DatabaseOutlined />,
    tag: "推荐",
  },
];

// ==================== 页面组件 ====================

export default function DataManagerPage() {
  // 导出状态
  const [exportType, setExportType] = useState<ExportType>("all");
  const [exporting, setExporting] = useState(false);

  // 导入状态
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [previewFile, setPreviewFile] = useState<UploadFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── 导出处理 ───
  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams({ type: exportType });
      const res = await fetch(`/api/admin/export?${params}`);

      if (!res.ok) {
        const error: any = await res.json();
        throw new Error(error.error || "导出失败");
      }

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
  }, [exportType]);

  // ─── 导入文件选择 ───
  const handleBeforeUpload = useCallback((file: File) => {
    // 只读取文件预览，不立即上传
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);

        // 基本格式校验
        if (!data.version || !data.exportedAt) {
          message.error("文件格式无效：缺少 version 或 exportedAt 字段");
          setPreviewFile(null);
          return false;
        }

        // 统计数据量
        const tables = Object.keys(data).filter(
          (k) => !["version", "exportedAt", "exportType"].includes(k) && Array.isArray(data[k]),
        );
        const totalRecords = tables.reduce((sum, t) => sum + (data[t]?.length || 0), 0);

        setPreviewFile({
          uid: "-1",
          name: file.name,
          size: file.size,
          status: "done",
          // 将解析结果存储在自定义字段中
          response: { data, tables, totalRecords } as unknown,
        });
      } catch {
        message.error("文件解析失败，请确认是有效的 JSON 文件");
        setPreviewFile(null);
      }
    };
    reader.readAsText(file);
    return false; // 阻止自动上传
  }, []);

  // ─── 确认导入 ───
  const handleConfirmImport = useCallback(async () => {
    if (!previewFile?.response) return;

    const { data } = previewFile.response as { data: Record<string, unknown> };
    setImporting(true);
    setImportResult(null);

    try {
      const res = await fetch("/api/admin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const result: any = await res.json();
      setImportResult(result);

      if (result.success) {
        message.success(result.message || "导入成功");
      } else {
        message.error(result.error || "导入失败");
      }
    } catch (err) {
      message.error("导入请求失败");
      setImportResult({
        success: false,
        message: err instanceof Error ? err.message : "导入失败",
      });
    } finally {
      setImporting(false);
    }
  }, [previewFile]);

  // ─── 清除预览文件 ───
  const handleClearPreview = useCallback(() => {
    setPreviewFile(null);
    setImportResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  // 预览文件信息
  const previewInfo = (previewFile?.response as { tables: string[]; totalRecords: number } | undefined) || null;

  // 导入结果详情表格列
  const resultColumns = [
    {
      title: "数据表",
      dataIndex: "table",
      key: "table",
      render: (v: string) => formatFieldName(v),
    },
    {
      title: "导入数",
      dataIndex: "imported",
      key: "imported",
      align: "right" as const,
      render: (v: number) => <Tag color="green">{v}</Tag>,
    },
    {
      title: "跳过数",
      dataIndex: "skipped",
      key: "skipped",
      align: "right" as const,
      render: (v: number) => <Tag color={v > 0 ? "orange" : "default"}>{v}</Tag>,
    },
  ];

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      {/* 标题 */}
      <div style={{ marginBottom: 24 }}>
        <Space>
          <DatabaseOutlined style={{ fontSize: 20, color: "#6b7280" }} />
          <div>
            <Title level={4} style={{ margin: 0 }}>数据管理</Title>
            <Text type="secondary">导入导出系统配置和业务数据</Text>
          </div>
        </Space>
      </div>

      {/* ─── 导出区域 ─── */}
      <Card title="数据导出" style={{ marginBottom: 24 }}>
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          选择要导出的数据类型，系统将生成 JSON 文件供下载。
        </Paragraph>

        <Radio.Group
          value={exportType}
          onChange={(e) => setExportType(e.target.value)}
          style={{ width: "100%" }}
        >
          <Space direction="vertical" style={{ width: "100%" }}>
            {EXPORT_OPTIONS.map((opt) => (
              <Radio key={opt.value} value={opt.value} style={{ width: "100%" }}>
                <Card
                  size="small"
                  hoverable
                  style={{
                    border: exportType === opt.value ? "1px solid #3b82f6" : undefined,
                    backgroundColor: exportType === opt.value ? "#eff6ff" : undefined,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 18, color: "#6b7280" }}>{opt.icon}</span>
                    <div>
                      <Space>
                        <Text strong>{opt.label}</Text>
                        {opt.tag && <Tag color="blue">{opt.tag}</Tag>}
                      </Space>
                      <div>
                        <Text type="secondary" style={{ fontSize: 12 }}>{opt.description}</Text>
                      </div>
                    </div>
                  </div>
                </Card>
              </Radio>
            ))}
          </Space>
        </Radio.Group>

        <Divider />

        <Button
          type="primary"
          icon={<DownloadOutlined />}
          loading={exporting}
          onClick={handleExport}
          size="large"
        >
          导出数据
        </Button>
      </Card>

      {/* ─── 导入区域 ─── */}
      <Card title="数据导入" style={{ marginBottom: 24 }}>
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message="导入操作会覆盖已有数据"
          description="请确保导入的 JSON 文件是通过本系统导出的。导入前建议先备份当前数据。"
          style={{ marginBottom: 16 }}
        />

        <Dragger
          accept=".json"
          showUploadList={false}
          beforeUpload={handleBeforeUpload}
          disabled={importing}
          style={{ marginBottom: previewFile ? 16 : 0 }}
        >
          <p className="ant-upload-drag-icon">
            <UploadOutlined style={{ fontSize: 40, color: "#3b82f6" }} />
          </p>
          <p className="ant-upload-text">点击或拖拽 JSON 文件到此处</p>
          <p className="ant-upload-hint">支持本系统导出的 JSON 格式文件</p>
        </Dragger>

        {/* 预览信息 */}
        {previewFile && previewInfo && (
          <Card
            size="small"
            style={{ marginTop: 16, border: "1px solid #e5e7eb" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <Space>
                <CheckCircleOutlined style={{ color: "#10b981" }} />
                <Text strong>{previewFile.name}</Text>
              </Space>
              <Button size="small" onClick={handleClearPreview}>
                取消
              </Button>
            </div>

            <div style={{ display: "flex", gap: 24, marginBottom: 12 }}>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>文件大小</Text>
                <div>
                  <Text>{previewFile.size ? `${(previewFile.size / 1024).toFixed(1)} KB` : "-"}</Text>
                </div>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>数据表数</Text>
                <div>
                  <Text>{previewInfo.tables.length}</Text>
                </div>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>总记录数</Text>
                <div>
                  <Text>{previewInfo.totalRecords}</Text>
                </div>
              </div>
            </div>

            {previewInfo.tables.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>包含的数据表：</Text>
                <div style={{ marginTop: 4 }}>
                  {previewInfo.tables.map((t) => (
                    <Tag key={t} style={{ marginBottom: 4 }}>{formatFieldName(t)}</Tag>
                  ))}
                </div>
              </div>
            )}

            <Button
              type="primary"
              icon={<UploadOutlined />}
              loading={importing}
              onClick={handleConfirmImport}
            >
              确认导入
            </Button>
          </Card>
        )}

        {/* 导入结果 */}
        {importResult && (
          <Card
            size="small"
            style={{
              marginTop: 16,
              border: importResult.success ? "1px solid #10b981" : "1px solid #ef4444",
            }}
          >
            <Alert
              type={importResult.success ? "success" : "error"}
              showIcon
              message={importResult.success ? "导入成功" : "导入失败"}
              description={importResult.message}
              style={{ marginBottom: importResult.details ? 12 : 0 }}
            />

            {importResult.details && Object.keys(importResult.details).length > 0 && (
              <Table
                columns={resultColumns}
                dataSource={Object.entries(importResult.details).map(([table, stats]) => ({
                  key: table,
                  table,
                  imported: stats.imported,
                  skipped: stats.skipped,
                }))}
                size="small"
                pagination={false}
                style={{ marginTop: 12 }}
              />
            )}
          </Card>
        )}
      </Card>
    </div>
  );
}
