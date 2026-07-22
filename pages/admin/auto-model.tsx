/**
 * 自动模型管理页
 *
 * 功能：
 * - 自动模型 ID 生成与配置
 * - 平台模型发现（从各平台获取模型列表）
 * - 模型选择（选择参与自动分流的模型）
 *
 * 主分支对应文件：src/app/admin/auto-model/page.tsx
 * 迁移变更：
 * - App Router → Pages Router
 * - @lobehub/ui 组件 → Ant Design 5
 * - lucide-react 图标 → @ant-design/icons
 * - react-i18next → 中文直接写死
 */

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  Table,
  Button,
  Form,
  Select,
  message,
  Space,
  Tag,
  Popconfirm,
  Input,
  Typography,
  Spin,
  Alert,
  Tooltip,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ThunderboltOutlined,
  CopyOutlined,
  CheckOutlined,
  ReloadOutlined,
  DatabaseOutlined,
  SearchOutlined,
  DeleteOutlined,
  SaveOutlined,
} from "@ant-design/icons";

const { Text, Paragraph } = Typography;

// ==================== 类型定义 ====================

interface PlatformModel {
  id: string;
  modelId: string;
  ownedBy: string | null;
  source: string;
  fetchedAt: string;
  platform: { name: string };
}

interface Platform {
  id: number;
  name: string;
}

// ==================== 页面组件 ====================

export default function AutoModelPage() {
  // 自动模型 ID 状态
  const [autoModelId, setAutoModelId] = useState<string | null>(null);
  const [autoModelLoading, setAutoModelLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // 平台模型发现状态
  const [models, setModels] = useState<PlatformModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  // 模型选择状态
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [selectedModelsLoading, setSelectedModelsLoading] = useState(false);

  // ─── 加载所有数据 ───
  useEffect(() => {
    const controller = new AbortController();

    const fetchAllData = async () => {
      setModelsLoading(true);

      // 加载自动模型 ID 配置
      try {
        const res = await fetch("/api/admin/config", { signal: controller.signal });
        const data: any = await res.json();
        if (data.success && data.data) {
          setAutoModelId(data.data["system:auto_model_id"] || null);
          const savedModels = data.data["system:auto_model_selected"];
          if (savedModels) {
            try {
              setSelectedModels(JSON.parse(savedModels));
            } catch {
              setSelectedModels([]);
            }
          }
        }
      } catch {
        // 静默失败
      }

      // 加载平台模型
      try {
        const pRes = await fetch("/api/admin/platforms", { signal: controller.signal });
        const pData: any = await pRes.json();
        if (pData.success && Array.isArray(pData.data)) {
          const allModels: PlatformModel[] = [];
          for (const platform of pData.data as Platform[]) {
            try {
              const mRes = await fetch(`/api/admin/platforms/${platform.id}/models`, { signal: controller.signal });
              const mData: any = await mRes.json();
              if (mData.success && Array.isArray(mData.data)) {
                for (const m of mData.data) {
                  allModels.push({ ...m, platform: { name: platform.name } });
                }
              }
            } catch {
              // 单个平台失败不影响其他平台
            }
          }
          setModels(allModels);
        }
      } catch {
        message.error("加载平台模型失败");
      } finally {
        if (!controller.signal.aborted) {
          setModelsLoading(false);
        }
      }
    };

    fetchAllData();
    return () => controller.abort();
  }, []);

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
      setCopied(true);
      message.success("已复制到剪贴板");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      message.error("复制失败");
    }
  }, [autoModelId]);

  // ─── 保存模型选择 ───
  const saveSelectedModels = useCallback(async () => {
    setSelectedModelsLoading(true);
    try {
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "system:auto_model_selected",
          value: JSON.stringify(selectedModels),
        }),
      });
      const data: any = await res.json();
      if (data.success) {
        message.success("模型选择已保存");
      } else {
        message.error(data.error || "保存失败");
      }
    } catch {
      message.error("保存失败");
    } finally {
      setSelectedModelsLoading(false);
    }
  }, [selectedModels]);

  // ─── 清空模型选择 ───
  const clearSelectedModels = useCallback(() => {
    setSelectedModels([]);
    saveSelectedModelsClear();
  }, []);

  const saveSelectedModelsClear = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key: "system:auto_model_selected",
          value: JSON.stringify([]),
        }),
      });
      const data: any = await res.json();
      if (data.success) {
        message.success("已清空模型选择");
      } else {
        message.error(data.error || "操作失败");
      }
    } catch {
      message.error("操作失败");
    }
  }, []);

  // ─── 表格列定义 ───
  const columns: ColumnsType<PlatformModel> = [
    {
      title: "平台",
      key: "platform",
      width: 140,
      render: (_: unknown, record: PlatformModel) => (
        <Space size={4}>
          <DatabaseOutlined style={{ color: "#999" }} />
          <span>{record.platform.name}</span>
        </Space>
      ),
    },
    {
      title: "模型 ID",
      dataIndex: "modelId",
      key: "modelId",
      ellipsis: true,
    },
    {
      title: "来源",
      dataIndex: "source",
      key: "source",
      width: 100,
      render: (v: string) => (
        <Tag color={v === "manual" ? "green" : "blue"}>
          {v === "manual" ? "手动" : "自动"}
        </Tag>
      ),
    },
    {
      title: "更新时间",
      dataIndex: "fetchedAt",
      key: "fetchedAt",
      width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
    },
  ];

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      {/* 自动模型 ID 配置 */}
      <Card
        title={
          <Space>
            <ThunderboltOutlined />
            <span>自动模型 ID</span>
          </Space>
        }
        style={{ marginBottom: 24 }}
      >
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          配置后，请求此模型 ID 时将自动轮询所有可用平台，从中选择一个可用模型进行路由。
        </Paragraph>

        {autoModelId ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Input
              value={autoModelId}
              readOnly
              style={{ fontFamily: "monospace", flex: 1 }}
            />
            <Tooltip title={copied ? "已复制" : "复制 ID"}>
              <Button
                icon={copied ? <CheckOutlined /> : <CopyOutlined />}
                onClick={copyAutoModelId}
              />
            </Tooltip>
            <Popconfirm
              title="确定要重新生成自动模型 ID？"
              description="重新生成后旧 ID 将失效。"
              onConfirm={regenerateAutoModelId}
              okText="确定"
              cancelText="取消"
            >
              <Button
                type="primary"
                icon={<ReloadOutlined />}
                loading={autoModelLoading}
              >
                重新生成
              </Button>
            </Popconfirm>
          </div>
        ) : (
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={autoModelLoading}
            onClick={regenerateAutoModelId}
          >
            启用自动模型
          </Button>
        )}
      </Card>

      {/* 模型选择器 */}
      <Card
        title={
          <Space>
            <SearchOutlined />
            <span>选择自动分流模型</span>
          </Space>
        }
        style={{ marginBottom: 24 }}
      >
        <Paragraph type="secondary" style={{ marginBottom: 16 }}>
          从已发现的模型中选择要参与自动分流的模型，支持搜索和多选。未选择任何模型时，将自动使用所有可用模型。
        </Paragraph>

        <div style={{ marginBottom: 16 }}>
          <Select
            mode="multiple"
            style={{ width: "100%" }}
            placeholder="搜索并选择模型..."
            value={selectedModels}
            onChange={setSelectedModels}
            loading={modelsLoading}
            showSearch
            filterOption={(input, option) =>
              String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())
            }
            options={models.map((m) => ({
              value: m.modelId,
              label: `${m.modelId} (${m.platform.name})`,
            }))}
            notFoundContent={modelsLoading ? <Spin size="small" /> : "暂无可用模型"}
            maxTagCount="responsive"
            maxTagPlaceholder={(omittedValues) => `+${omittedValues.length} 项`}
          />
        </div>

        <Space>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            onClick={saveSelectedModels}
            loading={selectedModelsLoading}
            disabled={selectedModels.length === 0}
          >
            保存选择
          </Button>
          {selectedModels.length > 0 && (
            <Popconfirm
              title="确定要清空所有选择的模型？"
              onConfirm={clearSelectedModels}
              okText="确定"
              cancelText="取消"
            >
              <Button icon={<DeleteOutlined />}>
                清空选择
              </Button>
            </Popconfirm>
          )}
        </Space>
      </Card>

      {/* 平台模型发现列表 */}
      <Card
        title={
          <Space>
            <DatabaseOutlined />
            <span>已发现的平台模型</span>
          </Space>
        }
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              setModelsLoading(true);
              // 重新加载：刷新整个页面
              window.location.reload();
            }}
            size="small"
          >
            刷新
          </Button>
        }
      >
        <Alert
          type="info"
          showIcon
          message="以下模型从已配置的平台中自动发现，无需手动添加。"
          style={{ marginBottom: 16 }}
        />
        <Table
          columns={columns}
          dataSource={models}
          rowKey="id"
          loading={modelsLoading}
          pagination={{
            pageSize: 10,
            showSizeChanger: false,
            showTotal: (total) => `共 ${total} 个模型`,
          }}
          size="middle"
          locale={{ emptyText: "暂无已发现的模型，请先在「平台管理」中配置平台。" }}
        />
      </Card>
    </div>
  );
}
