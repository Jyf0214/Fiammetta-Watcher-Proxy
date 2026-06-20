import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fiammetta Watcher Proxy",
  description: "OpenAI API 中转站路由代理",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
