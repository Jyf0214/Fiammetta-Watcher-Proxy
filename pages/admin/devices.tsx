/**
 * 设备管理页
 *
 * 启动期由 Docker / Docker-lite 容器按 NODE_NAME 注册/复用设备 UUID，
 * EdgeOne / Vercel / 本地开发 不在启动期调用（部署形态无容器启动语义），
 * 该页对应可看到空表。Cloudflare 部署下"设备管理"模块全部 stub：
 * - 侧边栏隐藏入口（本页不进 defaultMenuItems，CF 构建 alias 后即便地址直达
 *   也仅渲染"不支持"提示卡）
 *
 * 功能：
 * - 列表：按 lastSeenAt 倒序展示所有设备
 * - 删除：单条记录删除（不会让设备重新注册失败——启动期重新调用会按
 *   deviceName 唯一索引查重，本地删除不影响其他实例）
 */

import { useState, useEffect } from "react";
import {
  Popconfirm,
  Alert,
  Tag,
  message,
  Switch,
  Space,
  type TableColumnsType,
} from "antd";
import { Trash2, Server, ShieldOff, Zap, ZapOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { PageContainer } from "@/components/ui/PageContainer";
import { PageHeader } from "@/components/ui/PageHeader";
import { ProCard } from "@/components/ui/ProCard";
import { AsyncBoundary } from "@/components/ui/AsyncBoundary";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatDateTime } from "@/lib/timezone";
import { useApi, UNAUTHORIZED_MESSAGE } from "@/hooks/use-api";
import AdminLayout from "@/components/AdminLayout";

interface DeviceItem {
  id: string;
  deviceName: string;
  uuid: string;
  platform: string;
  address: string | null;
  appVersion: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  bootCount: number;
  warpEnabled: boolean;
  warpEnabledAt: string;
  warpEnabledBy: string | null;
}

/** CF 部署标志（构建期内联）。"cf" 时整页 stub，不请求 API */
const DEPLOY_PLATFORM = process.env.NEXT_PUBLIC_DEPLOY_PLATFORM || "";

export default function DevicesPage() {
  const { t } = useTranslation("admin");
  const isCloudflare = DEPLOY_PLATFORM === "cf";

  // 数据层：服务端分页
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const {
    data: devicesData,
    error,
    isLoading,
    mutate,
  } = useApi<{ total: number; items: DeviceItem[] }>(
    `/api/admin/devices?page=${page}&pageSize=${PAGE_SIZE}`
  );
  const devices = devicesData?.items ?? [];
  const total = devicesData?.total ?? 0;

  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("devices:loadFailed"));
    }
  }, [error, t]);

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/devices?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(t("devices:deleteSuccess"));
        void mutate();
      } else {
        message.error(data.error || t("devices:deleteFailed"));
      }
    } catch {
      message.error(t("devices:deleteFailed"));
    }
  };

  // 单台设备 Warp 开关：PATCH 写库后由 scheduler.cjs warp-reconcile 在最近一个
  // 健康检查周期（默认 5 分钟）内自动 reconcile；UI 立即刷新显示
  const handleToggleWarp = async (id: string, next: boolean) => {
    try {
      const res = await fetch("/api/admin/devices", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, warpEnabled: next }),
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(t("devices:warpToggleSuccess"));
        void mutate();
      } else {
        message.error(data.error || t("devices:warpToggleFailed"));
      }
    } catch {
      message.error(t("devices:warpToggleFailed"));
    }
  };

  // 当前可见页批量：POST /api/admin/devices?action=bulk-warp
  // 一次 updateMany + 一次审计；上限 500 台
  const handleBulkWarp = async (warpEnabled: boolean) => {
    if (devices.length === 0) {
      message.warning(t("devices:emptyTitle"));
      return;
    }
    const ids = devices.map((d) => d.id);
    try {
      const res = await fetch("/api/admin/devices?action=bulk-warp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, warpEnabled }),
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(t("devices:warpBulkSuccess", { count: data.data?.updated ?? ids.length }));
        void mutate();
      } else {
        message.error(data.error || t("devices:warpBulkFailed"));
      }
    } catch {
      message.error(t("devices:warpBulkFailed"));
    }
  };

  // CF 部署下整页 stub：API 不接、UI 不渲染列表
  if (isCloudflare) {
    return (
      <AdminLayout>
        <PageContainer>
          <PageHeader
            title={t("devices")}
            description={t("devicesDesc")}
            icon={<Server size={20} className="text-zinc-500 dark:text-zinc-400" />}
          />
          <ProCard>
            <Alert
              type="info"
              showIcon
              icon={<ShieldOff className="w-5 h-5" />}
              message={t("devices:cfStubTitle")}
              description={t("devices:cfStubDesc")}
            />
          </ProCard>
        </PageContainer>
      </AdminLayout>
    );
  }

  const columns: TableColumnsType<DeviceItem> = [
    {
      title: t("devices:colName"),
      dataIndex: "deviceName",
      key: "deviceName",
      width: 200,
      render: (name: string) => (
        <div className="flex items-center gap-2">
          <Server className="w-4 h-4 text-zinc-400 shrink-0" />
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{name}</span>
        </div>
      ),
    },
    {
      title: t("devices:colPlatform"),
      dataIndex: "platform",
      key: "platform",
      width: 110,
      render: (platform: string) => {
        // antd Tag 内置色板，避免 Tailwind JIT 动态 className 失效
        const colors: Record<string, string> = {
          docker: "blue",
          edgeone: "geekblue",
          vercel: "purple",
          cf: "orange",
          local: "default",
        };
        return (
          <Tag color={colors[platform] || "default"} className="!m-0">
            {platform}
          </Tag>
        );
      },
    },
    {
      title: t("devices:colUuid"),
      dataIndex: "uuid",
      key: "uuid",
      render: (uuid: string) => (
        <code className="text-xs font-mono text-zinc-500 dark:text-zinc-400 break-all">
          {uuid}
        </code>
      ),
    },
    {
      title: t("devices:colVersion"),
      dataIndex: "appVersion",
      key: "appVersion",
      width: 100,
      responsive: ["md"],
      render: (v: string | null) =>
        v ? <span className="text-xs">{v}</span> : <span className="text-zinc-400">-</span>,
    },
    {
      title: t("devices:colFirstSeen"),
      dataIndex: "firstSeenAt",
      key: "firstSeenAt",
      width: 170,
      responsive: ["lg"],
      render: (s: string) => formatDateTime(s),
    },
    {
      title: t("devices:colLastSeen"),
      dataIndex: "lastSeenAt",
      key: "lastSeenAt",
      width: 170,
      render: (s: string) => formatDateTime(s),
    },
    {
      title: t("devices:colBootCount"),
      dataIndex: "bootCount",
      key: "bootCount",
      width: 90,
      align: "right",
      render: (n: number) => (
        <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{n}</span>
      ),
    },
    {
      // 设备级 Warp 启用开关：管理后台独立控制每台设备是否拉起 warp-cli；
      // 切换后由 scheduler.cjs warp-reconcile 在最近一个健康检查周期
      //（默认 5 分钟）内 reconcile，UI 立即刷新显示 DB 状态
      title: t("devices:colWarpEnabled"),
      dataIndex: "warpEnabled",
      key: "warpEnabled",
      width: 110,
      render: (enabled: boolean, record: DeviceItem) => (
        <Switch
          size="small"
          checked={enabled}
          checkedChildren={
            <span className="flex items-center gap-1 text-[10px]">
              <Zap className="w-3 h-3" />
              {t("devices:warpEnabled")}
            </span>
          }
          unCheckedChildren={
            <span className="flex items-center gap-1 text-[10px] text-zinc-400">
              <ZapOff className="w-3 h-3" />
              {t("devices:warpDisabled")}
            </span>
          }
          onChange={(next) => void handleToggleWarp(record.id, next)}
        />
      ),
    },
    {
      title: t("devices:colWarpEnabledAt"),
      dataIndex: "warpEnabledAt",
      key: "warpEnabledAt",
      width: 170,
      responsive: ["lg"],
      render: (s: string) => formatDateTime(s),
    },
    {
      title: t("devices:colActions"),
      key: "actions",
      width: 90,
      align: "center",
      render: (_, record) => (
        <Popconfirm
          title={t("devices:deleteConfirmTitle")}
          description={t("devices:deleteConfirmDesc", { name: record.deviceName })}
          okText={t("common:confirm")}
          cancelText={t("common:cancel")}
          okButtonProps={{ danger: true }}
          onConfirm={() => void handleDelete(record.id)}
        >
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<Trash2 className="w-4 h-4 text-red-500" />}
            aria-label={t("common:delete")}
          />
        </Popconfirm>
      ),
    },
  ];

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          title={t("devices")}
          description={t("devicesDesc")}
          icon={<Server size={20} className="text-zinc-500 dark:text-zinc-400" />}
          extra={
            // 批量开关仅在有设备时显示；空表 / CF stub 不渲染
            total > 0 ? (
              <Space>
                <Popconfirm
                  title={t("devices:warpBulkConfirmTitle")}
                  description={t("devices:warpBulkConfirmDesc", {
                    count: devices.length,
                    warpEnabled: true,
                  })}
                  okText={t("devices:warpBulkOn")}
                  cancelText={t("common:cancel")}
                  onConfirm={() => void handleBulkWarp(true)}
                >
                  <Button variant="primary" size="sm" icon={<Zap className="w-3.5 h-3.5" />}>
                    {t("devices:warpBulkOn")}
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title={t("devices:warpBulkConfirmTitle")}
                  description={t("devices:warpBulkConfirmDesc", {
                    count: devices.length,
                    warpEnabled: false,
                  })}
                  okText={t("devices:warpBulkOff")}
                  cancelText={t("common:cancel")}
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void handleBulkWarp(false)}
                >
                  <Button variant="default" size="sm" icon={<ZapOff className="w-3.5 h-3.5" />}>
                    {t("devices:warpBulkOff")}
                  </Button>
                </Popconfirm>
              </Space>
            ) : undefined
          }
        />
        <AsyncBoundary isLoading={isLoading} error={error ? new Error(error.message) : null}>
          <ProCard>
            {total === 0 ? (
              <Alert
                type="info"
                showIcon
                message={t("devices:emptyTitle")}
                description={t("devices:emptyDesc")}
              />
            ) : (
              <ResponsiveTable<DeviceItem>
                columns={columns}
                dataSource={devices}
                rowKey="id"
                pagination={{
                  current: page,
                  pageSize: PAGE_SIZE,
                  total,
                  onChange: setPage,
                }}
              />
            )}
          </ProCard>
        </AsyncBoundary>
      </PageContainer>
    </AdminLayout>
  );
}