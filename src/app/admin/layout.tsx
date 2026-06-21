"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Layout, Menu, Button, Space, Tag, message } from "antd";
import {
  DashboardOutlined,
  CloudServerOutlined,
  KeyOutlined,
  SwapOutlined,
  FileTextOutlined,
  AuditOutlined,
  SettingOutlined,
  AlertOutlined,
  LogoutOutlined,
  GlobalOutlined,
  SunOutlined,
  MoonOutlined,
} from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useThemeMode } from "@/hooks/use-theme-mode";
import "@/lib/i18n";

const { Sider, Content, Header } = Layout;

export default function AdminPageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const { mode, cycle, isDark } = useThemeMode();
  const [collapsed, setCollapsed] = useState(false);
  const [username, setUsername] = useState("");

  // 登录页不使用管理后台布局
  const isLoginPage = pathname === "/admin/login";
  if (isLoginPage) {
    return <>{children}</>;
  }

  useEffect(() => {
    checkAuth();
    // 移动端自动折叠侧边栏
    const handleResize = () => {
      if (window.innerWidth < 768) {
        setCollapsed(true);
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const checkAuth = async () => {
    try {
      const res = await fetch("/api/admin/auth");
      const data = await res.json();
      if (data.success) {
        setUsername(data.data.username);
      } else {
        router.push("/admin/login");
      }
    } catch {
      router.push("/admin/login");
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/admin/auth", { method: "DELETE" });
      message.success(t("auth.logout_success"));
      router.push("/");
    } catch {
      message.error(t("common.error"));
    }
  };

  const toggleLanguage = () => {
    const newLang = i18n.language === "zh" ? "en" : "zh";
    i18n.changeLanguage(newLang);
  };

  const menuItems = [
    {
      key: "/admin",
      icon: <DashboardOutlined />,
      label: t("admin.dashboard"),
    },
    {
      key: "/admin/platforms",
      icon: <CloudServerOutlined />,
      label: t("admin.platforms"),
    },
    {
      key: "/admin/keys",
      icon: <KeyOutlined />,
      label: t("admin.keys"),
    },
    {
      key: "/admin/models",
      icon: <SwapOutlined />,
      label: t("admin.models"),
    },
    {
      key: "/admin/logs",
      icon: <FileTextOutlined />,
      label: t("admin.logs"),
    },
    {
      key: "/admin/audit",
      icon: <AuditOutlined />,
      label: t("admin.audit"),
    },
    {
      key: "/admin/system",
      icon: <SettingOutlined />,
      label: t("admin.system"),
    },
    {
      key: "/admin/events",
      icon: <AlertOutlined />,
      label: t("admin.events"),
    },
  ];

  // 根据当前 pathname 匹配菜单项，获取对应标题
  const currentPageTitle = (() => {
    const matched = menuItems.find(
      (item) => item.key === pathname || pathname.startsWith(item.key + "/")
    );
    return matched?.label ?? t("admin.dashboard");
  })();

  return (
    <Layout className={`min-h-screen ${isDark ? "dark" : ""}`}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme="dark"
        className="!z-[100]"
      >
        <div className="p-4 text-center">
          <h2 className="text-white text-lg font-bold m-0">
            {collapsed ? "FW" : "Fiammetta"}
          </h2>
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[pathname]}
          items={menuItems}
          onClick={({ key }) => router.push(key)}
        />
      </Sider>
      <Layout>
        <Header className="bg-white dark:bg-[#1f1f1f] px-4 flex items-center justify-between shadow-sm overflow-x-auto !h-auto !leading-normal">
          <Space size="small">
            <Tag color="blue" className="hidden sm:inline-block">{currentPageTitle}</Tag>
          </Space>
          <Space size="small" wrap>
            <Button
              icon={isDark ? <SunOutlined /> : <MoonOutlined />}
              onClick={cycle}
              type="text"
              size="small"
              title={mode === "dark" ? t("theme.light") : t("theme.dark")}
            />
            <Button
              icon={<GlobalOutlined />}
              onClick={toggleLanguage}
              type="text"
              size="small"
            >
              <span className="hidden md:inline">{i18n.language === "zh" ? "EN" : "中文"}</span>
            </Button>
            <Tag className="hidden sm:inline-block dark:bg-[#262626] dark:border-[#434343] dark:text-[#d9d9d9]">{username}</Tag>
            <Button
              icon={<LogoutOutlined />}
              onClick={handleLogout}
              type="text"
              danger
              size="small"
            >
              <span className="hidden md:inline">{t("auth.logout")}</span>
            </Button>
          </Space>
        </Header>
        <Content className="m-2 sm:m-4 p-3 sm:p-6 bg-white dark:bg-[#141414] rounded-lg shadow-sm dark:shadow-none dark:border dark:border-[#303030] min-h-[280px]">
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}
