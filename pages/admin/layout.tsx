/**
 * 管理后台布局
 *
 * 功能：
 * - 侧边栏导航（分组菜单、折叠/展开）
 * - 顶栏（面包屑、深色模式切换、退出登录）
 * - 认证检查（未登录自动跳转）
 * - 移动端响应式（抽屉式侧边栏）
 *
 * 主分支对应文件：src/app/admin/layout.tsx
 * 迁移变更：
 * - App Router → Pages Router（getInitialProps 或客户端路由）
 * - lucide-react 图标保留
 * - 自定义 SidebarItem/SidebarGroup → Ant Design Menu
 * - react-i18next → 中文直接写死
 * - CSS 变量 → Ant Design 组件样式
 */

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import {
  Layout,
  Menu,
  Button,
  Avatar,
  Dropdown,
  Drawer,
  Space,
  Typography,
  Spin,
  message,
  theme as antTheme,
} from "antd";
import type { MenuProps } from "antd";
import {
  DashboardOutlined,
  CloudServerOutlined,
  KeyOutlined,
  SwapOutlined,
  GlobalOutlined,
  ClusterOutlined,
  ThunderboltOutlined,
  FileTextOutlined,
  BarChartOutlined,
  AuditOutlined,
  AlertOutlined,
  SettingOutlined,
  DownloadOutlined,
  MenuOutlined,
  LogoutOutlined,
  BulbOutlined,
  UserOutlined,
  DatabaseOutlined,
} from "@ant-design/icons";

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

// ==================== 菜单配置 ====================

interface MenuItemConfig {
  key: string;
  icon: React.ReactNode;
  href: string;
  group: string;
  label: string;
}

const menuItems: MenuItemConfig[] = [
  { key: "dashboard", icon: <DashboardOutlined />, href: "/admin", group: "概览", label: "仪表盘" },
  { key: "platforms", icon: <CloudServerOutlined />, href: "/admin/platforms", group: "管理", label: "平台管理" },
  { key: "keys", icon: <KeyOutlined />, href: "/admin/keys", group: "管理", label: "密钥管理" },
  { key: "models", icon: <SwapOutlined />, href: "/admin/models", group: "管理", label: "模型映射" },
  { key: "proxies", icon: <GlobalOutlined />, href: "/admin/proxies", group: "管理", label: "代理管理" },
  { key: "proxy-pools", icon: <ClusterOutlined />, href: "/admin/proxy-pools", group: "管理", label: "代理池" },
  { key: "auto-model", icon: <ThunderboltOutlined />, href: "/admin/auto-model", group: "管理", label: "自动模型" },
  { key: "request-templates", icon: <FileTextOutlined />, href: "/admin/request-templates", group: "管理", label: "请求模板" },
  { key: "usage", icon: <BarChartOutlined />, href: "/admin/usage", group: "监控", label: "用量统计" },
  { key: "stats", icon: <BarChartOutlined />, href: "/admin/stats", group: "监控", label: "统计分析" },
  { key: "logs", icon: <FileTextOutlined />, href: "/admin/logs", group: "监控", label: "请求日志" },
  { key: "audit", icon: <AuditOutlined />, href: "/admin/audit", group: "监控", label: "审计日志" },
  { key: "events", icon: <AlertOutlined />, href: "/admin/events", group: "监控", label: "系统事件" },
  { key: "data-manager", icon: <DownloadOutlined />, href: "/admin/data-manager", group: "系统", label: "数据管理" },
  { key: "config", icon: <SettingOutlined />, href: "/admin/config", group: "系统", label: "系统配置" },
  { key: "system", icon: <SettingOutlined />, href: "/admin/system", group: "系统", label: "系统设置" },
];

// 按分组聚合菜单
function groupMenuItems(items: MenuItemConfig[]): Record<string, MenuItemConfig[]> {
  const groups: Record<string, MenuItemConfig[]> = {};
  for (const item of items) {
    groups[item.group] = groups[item.group] || [];
    groups[item.group].push(item);
  }
  return groups;
}

// ==================== 面包屑映射 ====================

const breadcrumbMap: Record<string, string> = {
  "/admin": "仪表盘",
  "/admin/platforms": "平台管理",
  "/admin/keys": "密钥管理",
  "/admin/models": "模型映射",
  "/admin/proxies": "代理管理",
  "/admin/proxy-pools": "代理池",
  "/admin/auto-model": "自动模型",
  "/admin/request-templates": "请求模板",
  "/admin/usage": "用量统计",
  "/admin/stats": "统计分析",
  "/admin/logs": "请求日志",
  "/admin/audit": "审计日志",
  "/admin/events": "系统事件",
  "/admin/data-manager": "数据管理",
  "/admin/config": "系统配置",
  "/admin/system": "系统设置",
};

// ==================== 布局组件 ====================

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { pathname } = useRouter();
  const { token } = antTheme.useToken();
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const isLoginPage = pathname === "/admin/login";

  // 认证检查
  useEffect(() => {
    if (isLoginPage) {
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    const checkAuth = async () => {
      try {
        const res = await fetch("/api/admin/auth", { signal: controller.signal });
        if (!res.ok) {
          router.replace("/admin/login");
          return;
        }
        const data: any = await res.json();
        if (data.success && data.data?.username) {
          setUsername(data.data.username);
        } else {
          router.replace("/admin/login");
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        router.replace("/admin/login");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    checkAuth();
    return () => controller.abort();
  }, [isLoginPage, router]);

  // 退出登录
  const handleLogout = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/auth", { method: "DELETE" });
      if (res.ok) {
        message.success("退出成功");
        router.push("/");
      } else {
        message.error("退出失败");
      }
    } catch {
      message.error("退出失败，请重试");
    }
  }, [router]);

  // 登录页不使用布局
  if (isLoginPage) {
    return <>{children}</>;
  }

  // 加载中
  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <Spin size="large" />
      </div>
    );
  }

  // 当前选中菜单
  const selectedKey = menuItems.find((item) => {
    if (item.href === "/admin") return pathname === "/admin";
    return pathname.startsWith(item.href);
  })?.key || "dashboard";

  // 按分组构建 Ant Design Menu items
  const grouped = groupMenuItems(menuItems);
  const menuPropsItems: MenuProps["items"] = Object.entries(grouped).map(([group, items]) => ({
    type: "group" as const,
    label: <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.15em", color: token.colorTextQuaternary }}>{group}</span>,
    children: items.map((item) => ({
      key: item.key,
      icon: item.icon,
      label: <Link href={item.href} style={{ textDecoration: "none" }}>{item.label}</Link>,
    })),
  }));

  // 侧边栏内容
  const sidebarContent = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 品牌头 */}
      <div style={{ padding: "20px 20px 16px", borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none" }}>
          <div style={{
            width: 36, height: 36,
            background: token.colorText,
            borderRadius: 10,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          }}>
            <span style={{ color: token.colorBgContainer, fontWeight: 900, fontSize: 14 }}>FW</span>
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: token.colorText, lineHeight: 1.2 }}>Fiammetta</div>
            <div style={{ fontSize: 9, fontWeight: 700, color: token.colorTextQuaternary, textTransform: "uppercase", letterSpacing: "0.15em" }}>Watcher Proxy</div>
          </div>
        </Link>
      </div>

      {/* 用户信息 */}
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "10px 12px",
          background: token.colorBgTextHover,
          borderRadius: 12,
          border: `1px solid ${token.colorBorderSecondary}`,
        }}>
          <Avatar
            size={36}
            icon={<UserOutlined />}
            style={{ backgroundColor: token.colorText }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: token.colorText, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {username}
            </div>
            <div style={{ fontSize: 9, fontWeight: 700, color: token.colorTextQuaternary, textTransform: "uppercase" }}>
              Administrator
            </div>
          </div>
          <Button
            type="text"
            icon={<LogoutOutlined />}
            onClick={handleLogout}
            style={{ color: token.colorTextQuaternary }}
            title="退出登录"
          />
        </div>
      </div>

      {/* 菜单 */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px 12px" }}>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={menuPropsItems}
          onClick={() => setDrawerOpen(false)}
          style={{ border: "none", background: "transparent" }}
        />
      </div>
    </div>
  );

  // 顶栏面包屑
  const breadcrumbText = breadcrumbMap[pathname] || "仪表盘";
  const showSecondLevel = pathname !== "/admin";

  return (
    <Layout style={{ minHeight: "100vh" }}>
      {/* 桌面端侧边栏 */}
      <Sider
        trigger={null}
        collapsible
        collapsed={collapsed}
        width={260}
        collapsedWidth={0}
        style={{
          overflow: "auto",
          height: "100vh",
          position: "fixed",
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: 100,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          display: "none",
        }}
        className="admin-sider-desktop"
      >
        {sidebarContent}
      </Sider>

      {/* 移动端抽屉 */}
      <Drawer
        placement="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={280}
        styles={{ body: { padding: 0 }, header: { display: "none" } }}
        className="admin-drawer-mobile"
      >
        {sidebarContent}
      </Drawer>

      {/* 主内容区 */}
      <Layout style={{ marginLeft: collapsed ? 0 : 260, transition: "margin-left 0.2s" }}>
        {/* 顶栏 */}
        <Header style={{
          padding: "0 24px",
          display: "flex",
          alignItems: "center",
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          position: "sticky",
          top: 0,
          zIndex: 50,
          height: 56,
        }}>
          <Button
            type="text"
            icon={<MenuOutlined />}
            onClick={() => setDrawerOpen(true)}
            style={{ display: "none" }}
            className="admin-menu-btn-mobile"
          />
          <nav style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14, color: token.colorTextQuaternary }}>
            <span>系统管理</span>
            {showSecondLevel && (
              <>
                <span style={{ color: token.colorTextTertiary }}>/</span>
                <span style={{ fontWeight: 500, color: token.colorText }}>{breadcrumbText}</span>
              </>
            )}
          </nav>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
            <Dropdown
              menu={{
                items: [
                  { key: "logout", icon: <LogoutOutlined />, label: "退出登录", onClick: handleLogout },
                ],
              }}
              trigger={["click"]}
            >
              <Button type="text" icon={<UserOutlined />} style={{ color: token.colorTextSecondary }}>
                {username}
              </Button>
            </Dropdown>
          </div>
        </Header>

        {/* 内容 */}
        <Content style={{ padding: 24, background: token.colorBgLayout }}>
          {children}
        </Content>
      </Layout>

      {/* 响应式样式 */}
      <style jsx global>{`
        @media (min-width: 768px) {
          .admin-sider-desktop { display: flex !important; }
          .admin-menu-btn-mobile { display: none !important; }
        }
        @media (max-width: 767px) {
          .admin-sider-desktop { display: none !important; }
          .admin-menu-btn-mobile { display: inline-flex !important; }
          .ant-layout { margin-left: 0 !important; }
        }
      `}</style>
    </Layout>
  );
}
