/**
 * Cloudflare Tunnel 设备管理页
 *
 * 列出所有已注册设备，每台设备独立管理 1 个 cloudflared tunnel token：
 * - 设 Token：填入 Cloudflare Zero Trust 复制的 token（base64 JWT）
 * - 启动：在本设备主进程 spawn cloudflared tunnel run --token <T>
 * - 停止：kill 本设备主进程的 cloudflared 子进程
 * - 整页 reconcile：依 token 状态自动 spawn / stop（与 warp-reconcile 同模式）
 *
 * 关键事实：cloudflared tunnel 是出站 QUIC/WebSocket 连 Cloudflare 边缘，**无需
 * 任何容器特权**（cap_drop: ALL + no-new-privileges 加固保持）。TUN 设备用于本地
 * 入站服务暴露，本项目出站建隧道不创建 TUN 接口。
 *
 * 部署矩阵：CF 部署整页 stub（与 devices / 一致：device_registrations 表 schema
 * 同步在 init.sql，但 CF 部署下无 registerDevice 调用，表通常为空）。
 */

import { useState, useEffect } from "react";
import {
  Popconfirm,
  Alert,
  Tag,
  message,
  Space,
  type TableColumnsType,
} from "antd";
import { Cable, Play, Square, RefreshCw, Server, ShieldOff, Zap } from "lucide-react";
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

interface TunnelItem {
  id: string;
  deviceName: string;
  uuid: string;
  platform: string;
  hasToken: boolean;
  tokenSummary: string | null;
  tunnelStartedAt: number;
  tunnelStartedBy: string | null;
  lastSeenAt: string;
}

/** CF 部署标志（构建期内联）。"cf" 时整页 stub，不请求 API */
const DEPLOY_PLATFORM = process.env.NEXT_PUBLIC_DEPLOY_PLATFORM || "";

export default function TunnelsPage() {
  const { t } = useTranslation("admin");
  const isCloudflare = DEPLOY_PLATFORM === "cf";

  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const {
    data: tunnelsData,
    error,
    isLoading,
    mutate,
  } = useApi<{ total: number; items: TunnelItem[] }>(
    `/api/admin/devices?page=${page}&pageSize=${PAGE_SIZE}`
  );
  const items = tunnelsData?.items ?? [];
  const total = tunnelsData?.total ?? 0;

  useEffect(() => {
    if (error && error.message !== UNAUTHORIZED_MESSAGE) {
      message.error(t("loadFailed"));
    }
  }, [error, t]);

  // 启动单台：本进程 spawn cloudflared（管理后台与目标设备在同进程时有效；
  // 多实例下此 API 仅作用于本实例 + DB 写操作远程生效）
  const handleStart = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/tunnels/${encodeURIComponent(id)}?action=start`, {
        method: "POST",
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(t("startSuccess"));
        void mutate();
      } else {
        message.error(data.error || t("startFailed"));
      }
    } catch {
      message.error(t("startFailed"));
    }
  };

  const handleStop = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/tunnels/${encodeURIComponent(id)}?action=stop`, {
        method: "POST",
      });
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(t("stopSuccess"));
        void mutate();
      } else {
        message.error(data.error || t("stopFailed"));
      }
    } catch {
      message.error(t("stopFailed"));
    }
  };

  const handleReconcile = async (id: string) => {
    try {
      const res = await fetch(
        `/api/admin/tunnels/${encodeURIComponent(id)}?action=reconcile`,
        { method: "POST" }
      );
      const data: Record<string, any> = await res.json();
      if (data.success) {
        message.success(
          t("reconcileSuccess", {
            action: data.data?.action ?? "noop",
            reason: data.data?.reason ?? "",
          })
        );
        void mutate();
      } else {
        message.error(data.error || t("reconcileFailed"));
      }
    } catch {
      message.error(t("reconcileFailed"));
    }
  };

  // CF 部署下整页 stub
  if (isCloudflare) {
    return (
      <AdminLayout>
        <PageContainer>
          <PageHeader
            title={t("tunnels")}
            description={t("tunnelsDesc")}
            icon={<Cable size={20} className="text-zinc-500 dark:text-zinc-400" />}
          />
          <ProCard>
            <Alert
              type="info"
              showIcon
              icon={<ShieldOff className="w-5 h-5" />}
              message={t("cfStubTitle")}
              description={t("cfStubDesc")}
            />
          </ProCard>
        </PageContainer>
      </AdminLayout>
    );
  }

  const columns: TableColumnsType<TunnelItem> = [
    {
      title: t("colDeviceName"),
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
      title: t("colPlatform"),
      dataIndex: "platform",
      key: "platform",
      width: 110,
      render: (platform: string) => {
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
      title: t("colToken"),
      dataIndex: "hasToken",
      key: "hasToken",
      width: 280,
      render: (hasToken: boolean, record: TunnelItem) => (
        hasToken ? (
          <code className="text-xs font-mono text-zinc-700 dark:text-zinc-300">
            {record.tokenSummary ?? t("tokenMissingFallback")}
          </code>
        ) : (
          <Tag color="default" className="!m-0">
            {t("noToken")}
          </Tag>
        )
      ),
    },
    {
      title: t("colStartedAt"),
      dataIndex: "tunnelStartedAt",
      key: "tunnelStartedAt",
      width: 170,
      render: (s: number) =>
        s > 0 ? (
          <span className="text-xs">{formatDateTime(new Date(s * 1000).toISOString())}</span>
        ) : (
          <span className="text-zinc-400">-</span>
        ),
    },
    {
      title: t("colLastSeen"),
      dataIndex: "lastSeenAt",
      key: "lastSeenAt",
      width: 170,
      responsive: ["lg"],
      render: (s: string) => formatDateTime(s),
    },
    {
      title: t("colActions"),
      key: "actions",
      width: 320,
      align: "right",
      render: (_, record) => (
        <Space size="small">
          <Popconfirm
            title={t("startConfirmTitle")}
            description={t("startConfirmDesc", { name: record.deviceName })}
            okText={t("common:confirm")}
            cancelText={t("common:cancel")}
            onConfirm={() => void handleStart(record.id)}
            disabled={!record.hasToken}
          >
            <Button
              variant="primary"
              size="sm"
              icon={<Play className="w-3 h-3" />}
              disabled={!record.hasToken}
            >
              {t("start")}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={t("stopConfirmTitle")}
            description={t("stopConfirmDesc", { name: record.deviceName })}
            okText={t("common:confirm")}
            cancelText={t("common:cancel")}
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleStop(record.id)}
          >
            <Button
              variant="default"
              size="sm"
              icon={<Square className="w-3 h-3" />}
            >
              {t("stop")}
            </Button>
          </Popconfirm>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className="w-3 h-3" />}
            onClick={() => void handleReconcile(record.id)}
            aria-label={t("reconcile")}
          />
        </Space>
      ),
    },
  ];

  return (
    <AdminLayout>
      <PageContainer>
        <PageHeader
          title={t("tunnels")}
          description={t("tunnelsDesc")}
          icon={<Cable size={20} className="text-zinc-500 dark:text-zinc-400" />}
        />
        <AsyncBoundary isLoading={isLoading} error={error ? new Error(error.message) : null}>
          <ProCard>
            {total === 0 ? (
              <Alert
                type="info"
                showIcon
                icon={<Cable className="w-5 h-5" />}
                message={t("emptyTitle")}
                description={t("emptyDesc")}
              />
            ) : (
              <>
                <Alert
                  type="info"
                  showIcon
                  icon={<Zap className="w-4 h-4" />}
                  message={t("outboundOnlyTitle")}
                  description={t("outboundOnlyDesc")}
                  className="mb-3"
                />
                <ResponsiveTable<TunnelItem>
                  columns={columns}
                  dataSource={items}
                  rowKey="id"
                  pagination={{
                    current: page,
                    pageSize: PAGE_SIZE,
                    total,
                    onChange: setPage,
                  }}
                />
              </>
            )}
          </ProCard>
        </AsyncBoundary>
      </PageContainer>
    </AdminLayout>
  );
}
