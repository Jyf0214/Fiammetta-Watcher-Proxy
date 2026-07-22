/**
 * HTML 文档结构
 *
 * 功能：
 * - 中文语言声明
 * - 禁止搜索引擎索引
 * - Ant Design 样式 SSR 注入（避免样式闪烁）
 */

import { Html, Head, Main, NextScript } from "next/document";
import { createCache, extractStyle, StyleProvider } from "@ant-design/cssinjs";

export default function Document() {
  return (
    <Html lang="zh-CN">
      <Head>
        <meta name="robots" content="noindex, nofollow, nosnippet, noimageindex" />
        <meta name="description" content="OpenAI API 中转站路由代理" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}

/**
 * getInitialProps — Ant Design 样式 SSR
 * 确保首屏加载时 Ant Design 样式已内联，避免 FOUC（样式闪烁）
 */
Document.getInitialProps = async (ctx: any) => {
  const cache = createCache();
  const originalRenderPage = ctx.renderPage;

  ctx.renderPage = () =>
    originalRenderPage({
      enhanceApp: (App: any) => (props: any) => (
        <StyleProvider cache={cache}>
          <App {...props} />
        </StyleProvider>
      ),
    });

  const initialProps = await ctx.defaultGetInitialProps(ctx);
  const style = extractStyle(cache, true);

  return {
    ...initialProps,
    styles: (
      <>
        {initialProps.styles}
        <style dangerouslySetInnerHTML={{ __html: style }} />
      </>
    ),
  };
};
