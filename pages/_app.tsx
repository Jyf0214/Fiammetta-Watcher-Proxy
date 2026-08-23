import type { AppProps } from "next/app"
import Head from "next/head"
import { useRouter } from "next/router"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ThemeProvider } from "next-themes"
import { AnimatePresence, LazyMotion, domMax } from "motion/react"
import "../styles/globals.css"
import "@/lib/i18n"
import { message } from "antd"
import RouteLoading from "@/components/RouteLoading"
import { AntdProvider } from "@/components/providers/AntdProvider"

// Toast 固定在导航栏下方，避免遮挡
message.config({ top: 60 })

export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter()
  const { t } = useTranslation("common")
  const [routeLoading, setRouteLoading] = useState(false)

  useEffect(() => {
    const handleStart = (url: string) => {
      // 登录页无管理后台布局，切换时不需要骨架屏遮罩
      if (url.startsWith("/admin") && !url.startsWith("/admin/login")) setRouteLoading(true)
    }
    const handleDone = () => setRouteLoading(false)

    router.events.on("routeChangeStart", handleStart)
    router.events.on("routeChangeComplete", handleDone)
    router.events.on("routeChangeError", handleDone)
    return () => {
      router.events.off("routeChangeStart", handleStart)
      router.events.off("routeChangeComplete", handleDone)
      router.events.off("routeChangeError", handleDone)
    }
  }, [router])

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <AntdProvider>
      <LazyMotion features={domMax} strict>
        <Head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="description" content={t("metaDescription")} />
          <title>{t("brandFull")}</title>
        </Head>
        <AnimatePresence>
          {routeLoading && <RouteLoading />}
        </AnimatePresence>
        <Component {...pageProps} />
      </LazyMotion>
      </AntdProvider>
    </ThemeProvider>
  )
}
