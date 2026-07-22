import { Html, Head, Main, NextScript } from 'next/document'
import '../styles/globals.css'

export default function Document() {
  return (
    <Html lang="zh-CN" suppressHydrationWarning>
      <Head>
        {/* viewport 设置（等同 App Router 的 viewport 导出） */}
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* 页面元信息（等同 App Router 的 metadata 导出） */}
        <title>Fiammetta Watcher Proxy</title>
        <meta name="description" content="OpenAI API 中转站路由代理" />
        <meta name="robots" content="noindex, nofollow, nosnippet, noimageindex" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
