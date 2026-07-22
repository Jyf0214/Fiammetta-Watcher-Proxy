import { useState, useEffect, useCallback } from "react";
import {
  Modal,
  Form,
  Input,
  Select,
  Popconfirm,
  message,
  type TableColumnsType,
} from "antd";
import { Plus, Trash2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import GlobalLoading from "@/components/Loading";
import AdminLayout from "@/components/AdminLayout";

interface ModelMap {
  id: string;
  alias: string;
  targetModel: string;
  platformId: string | null;
  platform: { name: string } | null;
}

interface Platform {
  id: string;
  name: string;
}

export default function ModelsPage() {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelMap[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    const fetchModels = async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/models", { signal: controller.signal });
        const data = await res.json();
        if (data.success && Array.isArray(data.data)) setModels(data.data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error(t("common.error"));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    const fetchPlatforms = async () => {
      try {
        const res = await fetch("/api/admin/platforms", { signal: controller.signal });
        const data = await res.json();
        if (data.success && Array.isArray(data.data)) setPlatforms(data.data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        message.error(t("common.error"));
      }
    };

    fetchModels();
    fetchPlatforms();
    return () => controller.abort();
  }, [t, refreshKey]);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);

      const res = await fetch("/api/admin/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const data = await res.json();
      if (data.success) {
        message.success(data.message);
        setModalOpen(false);
        form.resetFields();
        handleRefresh();
      } else {
        message.error(data.error);
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
      const res = await fetch(`/api/admin/models/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        message.success(data.message || t("model_map.delete_success") || "删除成功");
        handleRefresh();
      } else {
        message.error(data.error || t("common.error"));
      }
    } catch {
      message.error(t("common.error"));
    }
  };

  const columns: TableColumnsType<ModelMap> = [
    {
      title: t("model_map.alias"),
      dataIndex: "alias",
      key: "alias",
      width: 200,
    },
    {
      title: t("model_map.target_model"),
      dataIndex: "targetModel",
      key: "targetModel",
      width: 240,
    },
    {
      title: t("model_map.platform"),
      key: "platform",
      width: 160,
      render: (_: unknown, record: ModelMap) =>
        record.platform?.name || t("model_map.auto_route"),
    },
    {
      title: t("common.actions"),
      key: "actions",
      width: 100,
      align: "center",
      render: (_: unknown, record: ModelMap) => (
        <Popconfirm
          title={t("common.confirm_delete")}
          onConfirm={() => handleDelete(record.id)}
        >
          <Button variant="dangerGhost" size="sm" icon={<Trash2 />} iconOnly aria-label={t("common.delete")}>
          </Button>
        </Popconfirm>
      ),
    },
  ];

  if (loading && models.length === 0) {
    return <GlobalLoading size="large" />;
  }

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          icon={<RefreshCw size={20} className="text-zinc-500 dark:text-zinc-400" />}
          title={t("admin.models")}
          description={t("admin.models_desc")}
          extra={
            <Button
              variant="primary"
              icon={<Plus />}
              onClick={() => {
                form.resetFields();
                setModalOpen(true);
              }}
            >
              {t("model_map.create_mapping")}
            </Button>
          }
        />

        <ProCard>
          <ResponsiveTable
            columns={columns}
            dataSource={models}
            rowKey="id"
            loading={loading}
            pagination={{ pageSize: 20 }}
          />
        </ProCard>

        <Modal
          title={t("model_map.create_mapping")}
          open={modalOpen}
          onCancel={() => {
            setModalOpen(false);
            form.resetFields();
          }}
          onOk={handleSubmit}
          confirmLoading={submitting}
          centered
          width={520}
          style={{ maxWidth: "90vw" }}
          styles={{ body: { padding: "16px 24px" } }}
        >
          <Form form={form} layout="vertical">
            <Form.Item
              name="alias"
              label={t("model_map.alias")}
              rules={[{ required: true }]}
            >
              <Input placeholder={t("model_map.alias_placeholder")} />
            </Form.Item>
            <Form.Item
              name="targetModel"
              label={t("model_map.target_model")}
              rules={[{ required: true }]}
            >
              <Input placeholder="gpt-4o-2024-08-06" />
            </Form.Item>
            <Form.Item name="platformId" label={t("model_map.platform")}>
              <Select allowClear placeholder={t("common.auto_select")}>
                {platforms.map((p) => (
                  <Select.Option key={p.id} value={p.id}>
                    {p.name}
                  </Select.Option>
                ))}
              </Select>
            </Form.Item>
          </Form>
        </Modal>
      </PageContainer>
    </AdminLayout>
  );
}
