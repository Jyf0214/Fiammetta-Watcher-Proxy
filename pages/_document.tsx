import { Html, Head, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    <Html lang="zh-CN" suppressHydrationWarning>
      <Head>
        {/* viewport 与 title 在 _app.tsx 的 next/head 中设置（_document 中会警告且无法去重） */}
        <meta name="description" content="OpenAI-compatible API proxy gateway" />
        <meta name="robots" content="noindex, nofollow, nosnippet, noimageindex" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
