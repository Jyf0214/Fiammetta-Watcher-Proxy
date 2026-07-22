/**
 * 首页（公开访问）
 *
 * 功能：
 * - 品牌导航栏
 * - Hero 区域（标题、描述、快速入口）
 * - 功能特性展示
 * - 快速开始代码示例
 * - 底部版权
 *
 * 主分支对应文件：src/app/page.tsx
 * 迁移变更：
 * - App Router → Pages Router
 * - motion/react → CSS 动画（减少依赖）
 * - lucide-react 图标 → @ant-design/icons
 * - react-i18next → 中文直接写死
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button, Typography, Card, Tag } from "antd";
import {
  GlobalOutlined,
  ThunderboltOutlined,
  KeyOutlined,
  SafetyOutlined,
  BarChartOutlined,
  ApiOutlined,
  GithubOutlined,
  BookOutlined,
  CloudServerOutlined,
  MenuOutlined,
} from "@ant-design/icons";

const { Title, Paragraph, Text } = Typography;

// ==================== 功能特性 ====================

const features = [
  { icon: <GlobalOutlined style={{ fontSize: 24 }} />, title: "多平台聚合", desc: "支持 OpenAI、Azure 等多个上游平台，统一接口转发" },
  { icon: <ThunderboltOutlined style={{ fontSize: 24 }} />, title: "SSE 流式响应", desc: "完整支持 Server-Sent Events 流式输出，实时响应" },
  { icon: <KeyOutlined style={{ fontSize: 24 }} />, title: "密钥管理", desc: "多密钥轮询、配额控制、自动重置，灵活管理 API 密钥" },
  { icon: <SafetyOutlined style={{ fontSize: 24 }} />, title: "熔断保护", desc: "自动检测上游故障，智能熔断与恢复，保障服务稳定" },
  { icon: <BarChartOutlined style={{ fontSize: 24 }} />, title: "用量统计", desc: "详细的请求日志、Token 用量、性能指标分析" },
  { icon: <ApiOutlined style={{ fontSize: 24 }} />, title: "SDK 兼容", desc: "完美兼容 OpenAI SDK，零修改接入现有项目" },
];

// ==================== 快速开始代码 ====================

const quickStartCode = `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'https://your-domain.com/v1',
  apiKey: 'sk-your-api-key',
});

const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});

for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}`;

// ==================== 页面组件 ====================

export default function HomePage() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div style={{ minHeight: "100vh", background: "#fff" }}>
      {/* 导航栏 */}
      <nav style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 50,
        background: "rgba(255,255,255,0.8)", backdropFilter: "blur(12px)",
        borderBottom: "1px solid #f4f4f5",
      }}>
        <div style={{ maxWidth: 1152, margin: "0 auto", padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 32, height: 32,
              background: "#18181b", borderRadius: 8,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <CloudServerOutlined style={{ color: "#fff", fontSize: 14 }} />
            </div>
            <span style={{ fontWeight: 700, fontSize: 15, color: "#18181b" }}>Fiammetta</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Link href="#features" style={{ fontSize: 14, color: "#71717a", textDecoration: "none" }}>
              功能特性
            </Link>
            <Link href="#quickstart" style={{ fontSize: 14, color: "#71717a", textDecoration: "none" }}>
              快速开始
            </Link>
            <Link href="/admin/login">
              <Button type="primary" size="small" style={{ borderRadius: 10, fontWeight: 500 }}>
                管理后台
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero 区域 */}
      <section style={{ paddingTop: 120, paddingBottom: 64, padding: "120px 24px 64px" }}>
        <div style={{ maxWidth: 1152, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#a1a1aa", fontWeight: 800, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 24 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#18181b" }} />
            <span>OpenAI API Proxy</span>
          </div>

          <Title level={1} style={{ fontSize: 56, fontWeight: 900, letterSpacing: "-0.03em", marginBottom: 16, lineHeight: 1.1 }}>
            <div>Fiammetta</div>
            <div style={{ color: "#d4d4d8", marginTop: -8 }}>Watcher Proxy</div>
          </Title>

          <Paragraph style={{ fontSize: 18, color: "#71717a", maxWidth: 640, marginBottom: 32, lineHeight: 1.7 }}>
            高性能 OpenAI API 中转站，支持多平台聚合、密钥管理、负载均衡和实时监控。
            一键部署到 Cloudflare Workers，零运维成本。
          </Paragraph>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Link href="#quickstart">
              <Button size="large" icon={<BookOutlined />} style={{ borderRadius: 14, fontWeight: 500, height: 44 }}>
                快速开始
              </Button>
            </Link>
            <Link href="https://github.com/Jyf0214/Fiammetta-Watcher-Proxy" target="_blank" rel="noopener noreferrer">
              <Button size="large" icon={<GithubOutlined />} style={{ borderRadius: 14, fontWeight: 500, height: 44 }}>
                GitHub
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* 功能特性 */}
      <section id="features" style={{ padding: "64px 24px", background: "#fafafa" }}>
        <div style={{ maxWidth: 1152, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 64 }}>
            <Title level={2} style={{ fontWeight: 700, marginBottom: 16 }}>核心功能</Title>
            <Paragraph style={{ color: "#71717a", maxWidth: 480, margin: "0 auto" }}>
              为 OpenAI API 中转场景精心设计的全栈解决方案
            </Paragraph>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 24 }}>
            {features.map((feature, i) => (
              <Card
                key={feature.title}
                hoverable
                style={{ borderRadius: 20, border: "1px solid #f4f4f5" }}
                styles={{ body: { padding: 32 } }}
              >
                <div style={{
                  width: 48, height: 48,
                  background: "#f4f4f5", borderRadius: 14,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "#71717a", marginBottom: 16,
                }}>
                  {feature.icon}
                </div>
                <Title level={4} style={{ fontWeight: 700, marginBottom: 8 }}>{feature.title}</Title>
                <Paragraph style={{ color: "#71717a", fontSize: 14, lineHeight: 1.7 }}>
                  {feature.desc}
                </Paragraph>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* 快速开始 */}
      <section id="quickstart" style={{ padding: "64px 24px" }}>
        <div style={{ maxWidth: 1152, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 48 }}>
            <Title level={2} style={{ fontWeight: 700, marginBottom: 16 }}>快速开始</Title>
            <Paragraph style={{ color: "#71717a" }}>
              使用 OpenAI SDK 即可无缝接入
            </Paragraph>
          </div>

          <Card
            style={{ borderRadius: 16, border: "1px solid #e4e4e7", overflow: "hidden" }}
            styles={{ body: { padding: 0 } }}
          >
            <div style={{ padding: "12px 20px", borderBottom: "1px solid #f4f4f5", display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#ef4444" }} />
              <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#f59e0b" }} />
              <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#22c55e" }} />
              <span style={{ marginLeft: 8, fontSize: 13, color: "#a1a1aa" }}>quickstart.py</span>
            </div>
            <pre style={{
              margin: 0, padding: 24,
              fontSize: 13, lineHeight: 1.7,
              background: "#18181b", color: "#e4e4e7",
              overflow: "auto",
            }}>
              <code>{quickStartCode}</code>
            </pre>
          </Card>
        </div>
      </section>

      {/* 底部版权 */}
      <footer style={{ padding: "32px 24px", borderTop: "1px solid #f4f4f5", textAlign: "center" }}>
        <Text type="secondary" style={{ fontSize: 13 }}>
          Fiammetta Watcher Proxy © {new Date().getFullYear()} · Built with Cloudflare Workers
        </Text>
      </footer>
    </div>
  );
}
