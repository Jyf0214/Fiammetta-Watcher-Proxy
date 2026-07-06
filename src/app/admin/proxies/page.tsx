"use client";

import { useState, useEffect } from "react";
import {
  Card,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  message,
  Popconfirm,
  type TableColumnsType,
} from "antd";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PlusOutlined, DeleteOutlined, ReloadOutlined, UploadOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";

interface ProxyItem {
  id: string;
  address: string;
  platformId: string;
  enabled: boolean;
  status: string;
  failCount: number;
  lastFailAt: string | null;
  cooldownEnd: string | null;
  isBanned: boolean;
  platform: { id: string; name: string };
  createdAt: string;
}

interface PlatformOption {
  id: string;
  name: string;
}

export default function ProxiesPage() {
  const { t } = useTranslation();
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [platforms, setPlatforms] = useState<PlatformOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [filterPlatform, setFilterPlatform] = useState<string | undefined>();
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importPlatformId, setImportPlatformId] = useState<string | undefined>();
  const [importing, setImporting] = useState(false);
  const [form] = Form.useForm();

  const fetchProxies = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params = filterPlatform ? `?platformId=${filterPlatform}` : "";
      const res = await fetch(`/api/admin/proxies${params}`, { signal });
      if (res.status === 401) return;
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) setProxies(data.data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      message.error(t("common.error"));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  const fetchPlatforms = async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/admin/platforms", { signal });
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        setPlatforms(data.data.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name })));
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    const c = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchProxies(c.signal);
    fetchPlatforms(c.signal);
    return () => c.abort();
  }, [filterPlatform]);

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      const res = await fetch("/api/admin/proxies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (data.success) {
        message.success(t("proxy.create_success") || "创建成功");
        setModalOpen(false);
        form.resetFields();
        fetchProxies();
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch (err) {
      if (err && typeof err === "object" && "errorFields" in err) return;
      message.error(t("common.error"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/proxies/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        message.success(t("proxy.delete_success") || "删除成功");
        fetchProxies();
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    }
  };

  const handleToggle = async (proxy: ProxyItem) => {
    try {
      const res = await fetch(`/api/admin/proxies/${proxy.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !proxy.enabled }),
      });
      const data = await res.json();
      if (data.success) fetchProxies();
      else message.error(data.error || t("common.error"));
    } catch {
      message.error(t("common.error"));
    }
  };

  const handleReset = async (proxy: ProxyItem) => {
    try {
      const res = await fetch(`/api/admin/proxies/${proxy.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "healthy" }),
      });
      const data = await res.json();
      if (data.success) {
        message.success(t("proxy.reset_success") || "已重置");
        fetchProxies();
      }
    } catch {
      message.error(t("common.error"));
    }
  };

  const handleImport = async () => {
    if (!importText.trim()) {
      message.warning(t("proxy.import_empty") || "导入内容不能为空");
      return;
    }
    if (!importPlatformId) {
      message.warning(t("proxy.import_select_platform") || "请选择关联平台");
      return;
    }
    setImporting(true);
    try {
      const res = await fetch("/api/admin/proxies/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: importText, platformId: importPlatformId }),
      });
      const data = await res.json();
      if (data.success) {
        const { created, updated, parseErrors } = data.data || {};
        const msg = `新增 ${created} 个，覆盖 ${updated} 个` + (parseErrors?.length ? `，${parseErrors.length} 行格式错误` : "");
        message.success(msg);
        setImportModalOpen(false);
        setImportText("");
        setImportPlatformId(undefined);
        fetchProxies();
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    } finally {
      setImporting(false);
    }
  };

  const columns: TableColumnsType<ProxyItem> = [
    {
      title: t("proxy.address"),
      dataIndex: "address",
      key: "address",
      ellipsis: true,
      render: (v: string) => <span className="font-mono text-xs">{v.replace(/\/\/.*@/, "//***@")}</span>,
    },
    {
      title: t("proxy.platform"),
      key: "platformName",
      width: 140,
      render: (_: unknown, r: ProxyItem) => r.platform?.name || "-",
    },
    {
      title: t("common.status"),
      key: "status",
      width: 100,
      align: "center",
      render: (_: unknown, r: ProxyItem) => {
        if (r.isBanned) return <Tag color="red">{t("proxy.banned") || "封禁中"}</Tag>;
        if (r.status === "healthy") return <Tag color="green">{t("proxy.healthy") || "健康"}</Tag>;
        if (r.status === "degraded") return <Tag color="orange">{t("proxy.degraded") || "降级"}</Tag>;
        return <Tag color="red">{t("proxy.down") || "故障"}</Tag>;
      },
    },
    {
      title: t("proxy.fail_count"),
      dataIndex: "failCount",
      key: "failCount",
      width: 80,
      align: "center",
    },
    {
      title: t("common.actions"),
      key: "actions",
      fixed: "right",
      width: 180,
      align: "center",
      render: (_: unknown, r: ProxyItem) => (
        <div className="flex items-center justify-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => handleToggle(r)}>
            {r.enabled ? t("common.disable") : t("common.enable")}
          </Button>
          {r.isBanned && (
            <Button variant="ghost" size="sm" onClick={() => handleReset(r)}>
              {t("proxy.reset") || "重置"}
            </Button>
          )}
          <Popconfirm title={t("common.confirm_delete")} onConfirm={() => handleDelete(r.id)}>
            <Button variant="dangerGhost" size="sm" iconOnly icon={<DeleteOutlined />} />
          </Popconfirm>
        </div>
      ),
    },
  ];

  if (loading && proxies.length === 0) return <GlobalLoading size="large" />;

  return (
    <div>
      <div className="border-b border-zinc-100 dark:border-zinc-800 pb-4 mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100 mb-2">
          {t("admin.proxies")}
        </h1>
        <p className="text-zinc-500 dark:text-zinc-400 mb-6">
          {t("admin.proxies_desc")}
        </p>
      </div>

      <Card className="rounded-2xl shadow-sm border border-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
          <div className="flex items-center gap-3">
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              {t("common.total")}: {proxies.length}
            </span>
            <Select
              placeholder={t("proxy.filter_platform") || "按平台筛选"}
              allowClear
              className="w-40"
              onChange={(v) => setFilterPlatform(v)}
            >
              {platforms.map((p) => (
                <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>
              ))}
            </Select>
          </div>
          <div className="flex gap-2">
            <Button variant="default" icon={<ReloadOutlined />} onClick={() => fetchProxies()} disabled={loading}>
              {t("common.refresh")}
            </Button>
            <Button variant="default" icon={<UploadOutlined />} onClick={() => setImportModalOpen(true)}>
              {t("proxy.import") || "批量导入"}
            </Button>
            <Button variant="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setModalOpen(true); }}>
              {t("proxy.create_proxy") || "添加代理"}
            </Button>
          </div>
        </div>

        <ResponsiveTable
          columns={columns}
          dataSource={proxies}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (total) => t("common.pagination_total", { count: total }) }}
          scroll={{ x: 700 }}
          aria-label={t("admin.proxies")}
        />
      </Card>

      <Modal
        title={t("proxy.create_proxy") || "添加代理"}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields(); }}
        onOk={handleCreate}
        confirmLoading={submitting}
        centered
        width={520}
        style={{ maxWidth: "90vw" }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="address"
            label={t("proxy.address")}
            rules={[{ required: true }]}
            tooltip="http://user:pass@host:port 或 socks5://host:port"
          >
            <Input placeholder="http://127.0.0.1:7890" className="font-mono text-xs" />
          </Form.Item>
          <Form.Item
            name="platformId"
            label={t("proxy.platform")}
            rules={[{ required: true }]}
          >
            <Select placeholder={t("proxy.select_platform") || "选择关联平台"}>
              {platforms.map((p) => (
                <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t("proxy.import") || "批量导入代理"}
        open={importModalOpen}
        onCancel={() => { setImportModalOpen(false); setImportText(""); setImportPlatformId(undefined); }}
        onOk={handleImport}
        confirmLoading={importing}
        centered
        width={560}
        style={{ maxWidth: "90vw" }}
      >
        <div className="space-y-4">
          <div className="text-sm text-zinc-500 dark:text-zinc-400">
            每行一条，格式：<code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">IP:端口:账号:密码</code>
            <br />
            同一 IP、端口、账号、密码的代理将被覆盖。
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">{t("proxy.platform")}</label>
            <Select
              placeholder={t("proxy.select_platform") || "选择关联平台"}
              className="w-full"
              value={importPlatformId}
              onChange={setImportPlatformId}
            >
              {platforms.map((p) => (
                <Select.Option key={p.id} value={p.id}>{p.name}</Select.Option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">代理列表</label>
            <Input.TextArea
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
