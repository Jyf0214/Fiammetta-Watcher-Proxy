/**
 * 公开登录入口页
 *
 * 功能：
 * - 访问 /login 自动重定向到 /admin/login
 * - 作为公开可访问的登录入口
 *
 * 说明：
 * - 实际登录逻辑在 /admin/login 页面
 * - 此页面仅做重定向，保持 URL 友好
 */

import { useEffect } from "react";
import { useRouter } from "next/router";
import { Spin } from "antd";

export default function LoginPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/login");
  }, [router]);

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#fafafa",
    }}>
      <Spin size="large" tip="正在跳转..." />
    </div>
  );
}
