import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Fiammetta Watcher Proxy',
  description: '多平台 AI API 代理网关 — 统一接入、智能分流、用量监控',
  lang: 'zh-CN',
  lastUpdated: true,
  cleanUrls: true,

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'FWP Docs',

    nav: [
      { text: '指南', link: '/guide/what-is-fwp' },
      { text: 'API', link: '/api/' },
      { text: '部署', link: '/deployment/' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: '介绍',
          items: [
            { text: '什么是 FWP', link: '/guide/what-is-fwp' },
            { text: '功能特性', link: '/guide/features' },
            { text: '快速开始', link: '/guide/quickstart' },
          ]
        },
        {
          text: '使用指南',
          items: [
            { text: '平台配置', link: '/guide/platform' },
            { text: 'API Key 管理', link: '/guide/api-key' },
            { text: '模型映射', link: '/guide/model-map' },
            { text: '代理池', link: '/guide/proxy' },
            { text: '自动分流', link: '/guide/auto-model' },
          ]
        },
      ],
      '/api/': [
        {
          text: 'API 参考',
          items: [
            { text: '概述', link: '/api/' },
            { text: 'Chat Completions', link: '/api/chat-completions' },
            { text: 'Completions', link: '/api/completions' },
            { text: 'Embeddings', link: '/api/embeddings' },
            { text: 'Images', link: '/api/images' },
            { text: 'Models', link: '/api/models' },
          ]
        },
      ],
      '/deployment/': [
        {
          text: '部署',
          items: [
            { text: '部署指南', link: '/deployment/' },
            { text: 'Docker 部署', link: '/deployment/docker' },
            { text: '环境变量', link: '/deployment/env' },
            { text: 'Nginx 配置', link: '/deployment/nginx' },
          ]
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/Jyf0214/Fiammetta-Watcher-Proxy' }
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Jyf0214'
    },

    search: {
      provider: 'local'
    },

    editLink: {
      pattern: 'https://github.com/Jyf0214/Fiammetta-Watcher-Proxy/edit/main/docs/:path'
    },
  }
})
