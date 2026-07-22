/**
 * 代理管理页面
 *
 * 功能：
 * - 代理列表（地址/池/状态/失败次数/封禁次数），支持按池筛选
 * - 新增代理（Modal 表单：地址 + 选择代理池）
 * - 批量导入代理（Modal：多行文本输入 + 选择代理池）
 * - 启用/禁用切换、重置状态、删除（Popconfirm 确认）
 *
 * 主分支对应文件：src/app/admin/proxies/page.tsx
 * 迁移变更：
 * - @lobehub/ui → Ant Design 5 原生组件
 * - 自定义组件（ResponsiveTable/PageContainer/PageHeader/ProCard）→ antd 标准组件
 * - react-i18next → 中文直接写死
 * - useRouter from next/navigation → next/router（Pages Router）
 * - src/app/admin/proxies/page.tsx → pages/admin/proxies.tsx
 */

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import {
  Table,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  Button,
  Card,
  Space,
  Popconfirm,
  message,
  Typography,
  Spin,
} from "antd";
import type { TableColumnsType } from "antd";

const { Title } = Typography;
const { TextArea } = Input;

// ==================== 类型定义 ====================

interface ProxyItem {
  id: string;
  address: string;
  poolId: string | null;
  enabled: boolean;
  status: string;
  failCount: number;
  banCount: number;
  lastFailAt: string | null;
  cooldownEnd: string | null;
  isBanned: boolean;
  pool: { id: string; name: string } | null;
  createdAt: string;
}

interface PoolOption {
  id: string;
  name: string;
}

// ==================== 页面组件 ====================

export default function ProxiesPage() {
  const router = useRouter();
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [pools, setPools] = useState<PoolOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [filterPool, setFilterPool] = useState<string | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPoolId, setImportPoolId] = useState<string | undefined>();
  const [importing, setImporting] = useState(false);
  const [form] = Form.useForm();

  // 加载代理列表
  useEffect(() => {
    const controller = new AbortController();

    const fetchProxies = async () => {
      setLoading(true);
      try {
        const params = filterPool ? `?poolId=${filterPool}` : "";
        const res = await fetch(`/api/admin/proxies${params}`, { signal: controller.signal });
        if (res.status === 401) {
          message.warning("登录已过期，请重新登录");
          router.push("/admin/login");
          return;
        }
        const data: any = await res.json();
        if (data.success && Array.isArray(data.data)) setProxies(data.data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error("加载代理列表失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    const fetchPools = async () => {
      try {
        const res = await fetch("/api/admin/pools", { signal: controller.signal });
        const data: any = await res.json();
        if (data.success && Array.isArray(data.data)) {
          setPools(data.data.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })));
        }
      } catch { /* 忽略 */ }
    };

    fetchProxies();
    fetchPools();
    return () => controller.abort();
  }, [filterPool, router, refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // 新增代理
  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const res = await fetch("/api/admin/proxies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data: any = await res.json();
      if (data.success) {
        message.success("创建成功");
        setModalOpen(false);
        form.resetFields();
        handleRefresh();
      } else {
        message.error(data.error || "创建失败");
      }
    } catch (err) {
      if (err && typeof err === "object" && "errorFields" in err) return;
      message.error("创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  // 删除代理
  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/proxies/${id}`, { method: "DELETE" });
      const data: any = await res.json();
      if (data.success) {
        message.success("删除成功");
        handleRefresh();
      } else {
        message.error(data.error || "删除失败");
      }
    } catch {
      message.error("删除失败");
    }
  };

  // 启用/禁用切换
  const handleToggle = async (proxy: ProxyItem) => {
    try {
      const res = await fetch(`/api/admin/proxies/${proxy.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !proxy.enabled }),
      });
      const data: any = await res.json();
      if (data.success) handleRefresh();
      else message.error(data.error || "操作失败");
    } catch {
      message.error("操作失败");
    }
  };

  // 重置代理状态
  const handleReset = async (proxy: ProxyItem) => {
    try {
      const res = await fetch(`/api/admin/proxies/${proxy.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "healthy" }),
      });
      const data: any = await res.json();
      if (data.success) {
        message.success("已重置");
        handleRefresh();
      }
    } catch {
      message.error("重置失败");
    }
  };

  // 批量导入
  const handleImport = async () => {
    if (!importText.trim()) {
      message.warning("导入内容不能为空");
      return;
    }
    setImporting(true);
    try {
      const res = await fetch("/api/admin/proxies/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: importText, poolId: importPoolId || null }),
      });
      const data: any = await res.json();
      if (data.success) {
        const { created, updated, parseErrors } = data.data || {};
        const msg = `新增 ${created} 个，覆盖 ${updated} 个` + (parseErrors?.length ? `，${parseErrors.length} 行格式错误` : "");
        message.success(msg);
        setImportModalOpen(false);
        setImportText("");
        setImportPoolId(undefined);
        handleRefresh();
      } else {
        message.error(data.error || "导入失败");
      }
    } catch {
      message.error("导入失败");
    } finally {
      setImporting(false);
    }
  };

  // 表格列定义
  const columns: TableColumnsType<ProxyItem> = [
    {
      title: "地址",
      dataIndex: "address",
      key: "address",
      ellipsis: true,
      render: (v: string) => <span className="font-mono text-xs">{v.replace(/\/\/.*@/, "//***@")}</span>,
    },
    {
      title: "代理池",
      key: "poolName",
      width: 140,
      render: (_: unknown, r: ProxyItem) => r.pool?.name || <span className="text-zinc-400">未分组</span>,
    },
    {
      title: "状态",
      key: "status",
      width: 100,
      align: "center",
      render: (_: unknown, r: ProxyItem) => {
        if (r.isBanned) return <Tag color="red">封禁中</Tag>;
        if (r.status === "healthy") return <Tag color="green">健康</Tag>;
        if (r.status === "degraded") return <Tag color="orange">降级</Tag>;
        return <Tag color="red">故障</Tag>;
      },
    },
    {
      title: "封禁",
      dataIndex: "banCount",
      key: "banCount",
      width: 80,
      align: "center",
    },
    {
      title: "操作",
      key: "actions",
      fixed: "right",
      width: 180,
      align: "center",
      render: (_: unknown, r: ProxyItem) => (
        <Space size="small">
          <Button type="link" size="small" onClick={() => handleToggle(r)}>
            {r.enabled ? "禁用" : "启用"}
          </Button>
          {r.isBanned && (
            <Button type="link" size="small" onClick={() => handleReset(r)}>
              重置
            </Button>
          )}
          <Popconfirm title="确定删除该代理？" onConfirm={() => handleDelete(r.id)}>
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (loading && proxies.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: "50vh" }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div className="p-6" style={{ maxWidth: 960, margin: "0 auto" }}>
      {/* 页面标题 */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <Title level={4} style={{ margin: 0 }}>代理管理</Title>
          <p className="text-zinc-500 text-xs mt-1">管理上游代理服务器，支持批量导入和按池分组</p>
        </div>
        <Space>
          <Select
            placeholder="按代理池筛选"
            allowClear
            className="w-40"
            onChange={(v) => setFilterPool(v)}
            options={pools.map((p) => ({ value: p.id, label: p.name }))}
          />
          <Button onClick={handleRefresh} disabled={loading}>刷新</Button>
          <Button onClick={() => setImportModalOpen(true)}>批量导入</Button>
          <Button type="primary" onClick={() => { setModalOpen(true); form.resetFields(); }}>
            添加代理
          </Button>
        </Space>
      </div>

      {/* 代理列表 */}
      <Card>
        <div className="text-xs text-zinc-500 mb-3">共 {proxies.length} 个代理</div>
        <Table
          columns={columns}
          dataSource={proxies}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 条` }}
          scroll={{ x: 700 }}
          size="small"
        />
      </Card>

      {/* 新增代理 Modal */}
      <Modal
        title="添加代理"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields(); }}
        onOk={handleCreate}
        confirmLoading={submitting}
        centered
        width={520}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="address"
            label="代理地址"
            rules={[{ required: true, message: "请输入代理地址" }]}
            tooltip="http://user:pass@host:port 或 socks5://host:port"
          >
            <Input placeholder="http://127.0.0.1:7890" className="font-mono text-xs" />
          </Form.Item>
          <Form.Item name="poolId" label="代理池">
            <Select
              placeholder="选择代理池"
              allowClear
              options={pools.map((p) => ({ value: p.id, label: p.name }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 批量导入 Modal */}
      <Modal
        title="批量导入代理"
        open={importModalOpen}
        onCancel={() => { setImportModalOpen(false); setImportText(""); setImportPoolId(undefined); }}
        onOk={handleImport}
        confirmLoading={importing}
        centered
        width={560}
      >
        <div className="space-y-4">
          <div className="text-sm text-zinc-500">
            每行一条，格式：<code className="bg-zinc-100 px-1 rounded">IP:端口:账号:密码</code>
            <br />
            同一 IP、端口、账号、密码的代理将被覆盖。
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">代理池</label>
            <Select
              placeholder="选择代理池"
              className="w-full"
              value={importPoolId}
              onChange={setImportPoolId}
              allowClear
              options={pools.map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">代理列表</label>
            <TextArea
              rows={10}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={"142.111.67.146:5611:user1:pass1\n10.0.0.1:1080:user2:pass2"}
              className="font-mono text-xs"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
