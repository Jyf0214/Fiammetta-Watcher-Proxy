"use client";

import { motion } from "motion/react";
import {
  Zap,
  Globe,
  Key,
  Shield,
  Activity,
  BarChart3,
  ArrowRight,
  GitFork,
  BookOpen,
  Server,
} from "lucide-react";
import Link from "next/link";

const features = [
  {
    icon: <Globe className="text-2xl" />,
    title: "多平台路由",
    desc: "支持任意 OpenAI 兼容平台，权重负载均衡与自动故障转移",
  },
  {
    icon: <Zap className="text-2xl" />,
    title: "SSE 流式响应",
    desc: "完整支持 Chat Completions / Completions 流式与非流式代理",
  },
  {
    icon: <Key className="text-2xl" />,
    title: "API Key 管理",
    desc: "灵活的 Key 分发、额度控制、套餐模板与用量追踪",
  },
  {
    icon: <Shield className="text-2xl" />,
    title: "熔断与限流",
    desc: "自动熔断恢复、平台级 RPM/TPM 速率限制，保障系统稳定",
  },
  {
    icon: <BarChart3 className="text-2xl" />,
    title: "用量统计",
    desc: "详细的请求日志、Token 用量统计、审计日志与系统事件",
  },
  {
    icon: <Activity className="text-2xl" />,
    title: "SDK 兼容",
    desc: "标准 /v1 路径，兼容 OpenAI SDK，修改 base_url 即可接入",
  },
];

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

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950">
      {/* 导航栏 */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl border-b border-zinc-100 dark:border-zinc-800">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 sm:h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="w-7 h-7 sm:w-8 sm:h-8 bg-zinc-900 dark:bg-zinc-100 rounded-xl flex items-center justify-center">
              <Server className="text-white dark:text-zinc-900 text-xs sm:text-sm" />
            </div>
            <span className="font-bold text-sm sm:text-base text-zinc-900 dark:text-zinc-100">
              Fiammetta
            </span>
          </div>
          <div className="hidden md:flex items-center gap-4">
            <Link
              href="#features"
              className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            >
              功能
            </Link>
            <Link
              href="#quickstart"
              className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            >
              快速开始
            </Link>
            <Link
              href="/admin/login"
              className="text-sm px-4 py-2 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-xl hover:opacity-90 transition-opacity font-medium"
            >
              管理后台
            </Link>
          </div>
          {/* 移动端仅显示管理后台入口 */}
          <Link
            href="/admin/login"
            className="md:hidden text-sm px-3 py-1.5 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-xl hover:opacity-90 transition-opacity font-medium"
          >
            管理后台
          </Link>
        </div>
      </nav>

      {/* Hero 区域 */}
      <section className="pt-24 sm:pt-32 pb-16 sm:pb-20 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center gap-2 text-zinc-400 font-black text-[10px] uppercase tracking-[0.2em] mb-6"
          >
            <div className="w-1.5 h-1.5 rounded-full bg-zinc-900 dark:bg-zinc-100 animate-pulse" />
            <span>OpenAI API Proxy</span>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-3xl sm:text-5xl md:text-7xl font-black tracking-tighter text-zinc-900 dark:text-zinc-100 mb-4"
          >
            <div>Fiammetta</div>
            <div className="text-zinc-300 dark:text-zinc-600 -mt-2 sm:-mt-4 md:-mt-6">
              Watcher Proxy
            </div>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-base sm:text-lg text-zinc-500 dark:text-zinc-400 max-w-2xl mb-8 sm:mb-10 leading-relaxed"
          >
            智能 OpenAI API 中转站路由代理。多平台负载均衡、自动熔断恢复、
            SSE 流式响应、Token 额度管理 — 一行配置接入，SDK 无缝兼容。
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="flex flex-wrap gap-3 sm:gap-4"
          >
            <Link
              href="#quickstart"
              className="inline-flex items-center gap-2 px-5 sm:px-6 py-2.5 sm:py-3 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 rounded-2xl font-medium hover:opacity-90 transition-opacity text-sm sm:text-base"
            >
              <BookOpen size={18} />
              快速开始
            </Link>
            <Link
              href="https://github.com/Jyf0214/Fiammetta-Watcher-Proxy"
              target="_blank"
              className="inline-flex items-center gap-2 px-5 sm:px-6 py-2.5 sm:py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded-2xl font-medium hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors text-sm sm:text-base"
            >
              <GitFork size={18} />
              GitHub
            </Link>
          </motion.div>
        </div>
      </section>

      {/* 功能特性 */}
      <section id="features" className="py-16 sm:py-20 px-4 sm:px-6 bg-zinc-50 dark:bg-zinc-900/50">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 mb-4">
              核心功能
            </h2>
            <p className="text-zinc-500 dark:text-zinc-400 max-w-lg mx-auto">
              为 OpenAI API 提供企业级代理能力，开箱即用
            </p>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature, i) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
                className="bg-white dark:bg-zinc-800 rounded-3xl border border-zinc-100 dark:border-zinc-700 p-6 sm:p-8 hover:border-zinc-300 dark:hover:border-zinc-600 hover:shadow-lg transition-all duration-300"
              >
                <div className="w-12 h-12 bg-zinc-50 dark:bg-zinc-700 rounded-2xl flex items-center justify-center text-zinc-400 dark:text-zinc-300 mb-4">
                  {feature.icon}
                </div>
                <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-2">
                  {feature.title}
                </h3>
                <p className="text-zinc-500 dark:text-zinc-400 text-sm leading-relaxed">
                  {feature.desc}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* 快速开始 */}
      <section id="quickstart" className="py-16 sm:py-20 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 mb-4">
              快速开始
            </h2>
            <p className="text-zinc-500 dark:text-zinc-400 max-w-lg mx-auto">
              修改 base_url 即可接入，SDK 无缝兼容
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="bg-zinc-900 dark:bg-zinc-800 rounded-3xl p-4 sm:p-8 overflow-x-auto"
          >
            <div className="flex items-center gap-2 mb-4">
              <div className="w-3 h-3 rounded-full bg-red-500/80" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <div className="w-3 h-3 rounded-full bg-green-500/80" />
              <span className="ml-2 text-zinc-500 text-xs font-mono">
                quickstart.py
              </span>
            </div>
            <pre className="text-xs sm:text-sm text-zinc-300 font-mono leading-relaxed whitespace-pre overflow-x-auto">
              <code>{quickStartCode}</code>
            </pre>
          </motion.div>

          {/* 部署步骤 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
            {[
              {
                step: "01",
                title: "配置环境",
                desc: "设置 DATABASE_URL、JWT_SECRET、ADMIN 等环境变量",
              },
              {
                step: "02",
                title: "启动服务",
                desc: "docker-compose up -d 一键启动，自动初始化数据库",
              },
              {
                step: "03",
                title: "接入使用",
                desc: "在管理后台添加上游平台和 API Key，SDK 修改 base_url 即可",
              },
            ].map((item, i) => (
              <motion.div
                key={item.step}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
                className="flex gap-4"
              >
                <div className="text-4xl font-black text-zinc-200 dark:text-zinc-700">
                  {item.step}
                </div>
                <div>
                  <h3 className="font-bold text-zinc-900 dark:text-zinc-100 mb-1">
                    {item.title}
                  </h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    {item.desc}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* 页脚 */}
      <footer className="border-t border-zinc-100 dark:border-zinc-800 py-8 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-zinc-400 text-sm">
            <div className="w-5 h-5 bg-zinc-900 dark:bg-zinc-100 rounded-lg flex items-center justify-center">
              <Server className="text-white dark:text-zinc-900 text-[10px]" />
            </div>
            <span>Fiammetta Watcher Proxy</span>
          </div>
          <div className="flex items-center gap-4 text-zinc-400 text-sm">
            <Link
              href="https://github.com/Jyf0214/Fiammetta-Watcher-Proxy"
              target="_blank"
              className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            >
              <GitFork size={18} />
            </Link>
            <Link
              href="/admin/login"
              className="hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors flex items-center gap-1"
            >
              管理后台 <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
