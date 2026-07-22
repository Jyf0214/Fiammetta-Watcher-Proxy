/**
 * Next.js App 入口
 *
 * 功能：
 * - Ant Design 5 ConfigProvider（中文语言包）
 * - 全局主题配置（深色主色调、圆角统一）
 */

import type { AppProps } from "next/app";
import { ConfigProvider, theme, App as AntdApp } from "antd";
import zhCN from "antd/locale/zh_CN";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#18181b",
          borderRadius: 12,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        },
        components: {
          Menu: {
            itemBorderRadius: 8,
            iconSize: 18,
          },
          Table: {
            borderRadius: 12,
          },
          Card: {
            borderRadius: 12,
          },
          Button: {
            borderRadius: 10,
          },
        },
      }}
    >
      <AntdApp>
        <Component {...pageProps} />
      </AntdApp>
    </ConfigProvider>
  );
}
