"use client";

import { type ReactNode, useMemo } from "react";
import { ConfigProvider, App } from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { useTranslation } from "react-i18next";

/**
 * antd 全局配置 Provider — 统一 locale（中/英）和 theme token
 *
 * - locale 根据 i18n 当前语言切换，修复表格空态/分页等默认英文问题
 * - theme.token 将 CSS 变量映射到 antd token，替代 globals.css 中的 .dark .ant-* 硬覆盖
 * - App 组件为 message/notification/modal 静态方法提供主题上下文
 */
export function AntdProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();

  const locale = i18n.language?.startsWith("en") ? enUS : zhCN;

  const theme = useMemo(
    () => ({
      token: {
        colorPrimary: "#1a1a1a",
        colorLink: "#1a1a1a",
        colorLinkHover: "#27272a",
        colorLinkActive: "#1a1a1a",
        colorBgContainer: "var(--color-bg-container)",
        colorBgElevated: "var(--color-bg-elevated)",
        colorBgLayout: "var(--color-bg-layout)",
        colorText: "var(--color-text)",
        colorTextSecondary: "var(--color-text-secondary)",
        colorTextTertiary: "var(--color-text-tertiary)",
        colorTextQuaternary: "var(--color-text-quaternary)",
        colorBorder: "var(--color-border)",
        colorBorderSecondary: "var(--color-border-secondary)",
        colorBgSubtle: "var(--color-bg-subtle)",
        borderRadius: 8,
        fontFamily: "inherit",
      },
      components: {
        Table: {
          headerBg: "var(--color-bg-subtle)",
          headerColor: "var(--color-text-secondary)",
          rowHoverBg: "var(--color-fill-tertiary)",
        },
        Modal: {
          contentBg: "var(--color-bg-elevated)",
          headerBg: "var(--color-bg-elevated)",
          titleColor: "var(--color-text)",
        },
        Input: {
          colorBgContainer: "var(--color-bg-container)",
        },
        Select: {
          colorBgContainer: "var(--color-bg-container)",
          optionSelectedBg: "var(--color-fill)",
        },
        Card: {
          colorBgContainer: "var(--color-bg-container)",
        },
        Tag: {
          defaultBg: "var(--color-fill-secondary)",
          defaultColor: "var(--color-text-secondary)",
        },
        Pagination: {
          itemBg: "var(--color-bg-container)",
          itemColor: "var(--color-text-secondary)",
        },
        Message: {
          contentBg: "var(--color-bg-elevated)",
          contentColor: "var(--color-text)",
        },
        Tooltip: {
          colorBgSpotlight: "var(--color-bg-elevated)",
          colorTextLightSolid: "var(--color-text)",
        },
      },
    }),
    [],
  );

  return (
    <ConfigProvider locale={locale} theme={theme}>
      <App>{children}</App>
    </ConfigProvider>
  );
}

export default AntdProvider;
